/**
 * The one object the orchestrator wrapper takes (`createOrchestrator({ fleetMemory })`): it owns
 * the shared `memory` adapter and the `fleet_search` adapter, wraps the seat executor so every
 * seat's prompt carries the run's context injection, and tracks which step is calling a tool so a
 * delegated child's memory write is refused while its read is served.
 *
 * The injection is assembled in THREE TIERS (`tiers.ts`), in this order:
 *
 *   STABLE, built once per run and byte-identical across runs of the same profile —
 *     1. every named memory block (MEMORY.md / USER.md / COMPANY.md by default, config
 *        `memory.blocks`), the company's shared memory (frozen snapshot);
 *     2. the `workspace-context` seam (A2.1 hands the rendered text in; nothing here reads a file);
 *     3. the ORG-tier shared skills index — the same rows for every seat.
 *   CONTEXT, built once per (run, seat) —
 *     4. this seat's OWN live skills;
 *     5. the cross-agent recall for this objective and this seat, bounded by `recallBudgetChars`.
 *   VOLATILE, rebuilt whenever the surface changes it —
 *     6. the session transcript;
 *     7. the active personality's `systemPromptSuffix`. It reaches a prompt HERE and only here:
 *        never the system prompt, never the protected seat prompt (`improve/protected-prompt.ts`).
 *
 * Why the split. Until 2026-09-18 the whole prelude was memoised with the FIRST seat's scope, so
 * every later seat of a run was handed the first seat's recall and the first seat's skills. The
 * freeze was right about caching and wrong about scope: what must be byte-stable is the tier a
 * provider could cache (Hermes `memory_tool_store.py:347-350`), not the tier that answers "what
 * does THIS seat need". The run's view of the company is still frozen — `freezeFleetSource` caches
 * the reads for the life of the run — so a seat that calls later does not recall runs the seat
 * that called first could not see.
 *
 * The whole injection is measured against `context.ceiling_chars`. Over the ceiling, the context
 * and volatile tiers are trimmed oldest-first and the stable tier is never touched; at 80 percent
 * one `context_pressure` notice is emitted per run, not per seat call.
 *
 * It is appended to `dynamicPrompt`, the seat prompt field the pipeline already reserves for
 * per-step context (`apps/web/lib/model-gateway.ts` `buildSeatUserPrompt`), after the pipeline's
 * own text.
 */

import { createMemoryAdapter, type MemoryAdapter, type MemoryBlock } from "../tools/memory/index.js";
import { createBrainReadAdapter } from "../tools/memory/brain-read.js";
import { ORG_TIER_AGENT } from "../improve/org-tier.js";
import { worstProvenance } from "../governance/provenance.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { Provenance, TrentToolAdapter } from "../tools/types.js";
import { FAILURES_BLOCK, createStepObserver, recallFailures, writeFailure, type FailureRecord } from "./failures.js";
import { createBrain, type Brain } from "./brain.js";
import { brainSystemFileFor, migrateBlocksToBrain } from "./brain-migrate.js";
import { recallFromBrain } from "./brain-index.js";
import { renderBrainBlock } from "./brain-prompt.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import type { EmbedFn } from "./lexical.js";
import { recallForObjective } from "./recall.js";
import { createFleetSearchAdapter } from "./search.js";
import { listSharedSkills, renderSharedSkillsIndex } from "./shared-skills.js";
import {
  createInterruptionTracker,
  freezeFleetSource,
  guardInterrupted,
  isDelegatedObjective,
  withStepProvenance,
  type FleetMemorySource,
  type StepSettled,
} from "./source.js";
import {
  CONTEXT_BLOCKS,
  DEFAULT_CONTEXT_CEILING_CHARS,
  PRESSURE_WARNING_RATIO,
  assembleContext,
  estimateTokens,
  type AssembledContext,
  type ContextBlock,
} from "./tiers.js";

/** [G2] The end of one step's seat call, as the hook watched it (`source.ts` defines it). */
export type { StepSettled };

/**
 * The slice of the pipeline's `SeatModelExecutionInput` the hook reads and extends. `objective`
 * is optional only because the seat guard's structural slice omits it; the pipeline always sets it.
 */
export interface FleetSeatInput {
  readonly companyId?: string;
  readonly subtask: { readonly id: string; readonly seat: string; readonly objective?: string; readonly contextBundle?: unknown };
  readonly dynamicPrompt?: string;
}

/** One earlier turn of the surface's conversation, as the run carries it. */
export interface ConversationTurn {
  /** `system` is a compaction summary standing in for turns the transcript no longer holds. */
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** What a surface is told when the injection crosses the warning ratio. Measured, never a guess. */
export interface ContextNotice {
  readonly kind: "context_pressure";
  readonly runId: string;
  readonly seat: string;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly ceilingChars: number;
  readonly ratio: number;
  /** Names of the blocks the ceiling dropped for this seat, oldest first. */
  readonly dropped: readonly string[];
  /** One line naming the figures, for a log, a REPL warning or a `step_note` on the run bus. */
  readonly detail: string;
}

export interface RunStartedInput {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
  /**
   * The session's earlier turns, oldest first. Rendered in the VOLATILE tier, after the stable and
   * context tiers: a transcript in front of them moves the cacheable prefix every turn.
   */
  readonly history?: readonly ConversationTurn[];
}

export interface FleetMemoryHook {
  /** `memory` and `fleet_search`, to be wired into every seat like any toolset. */
  readonly adapters: readonly TrentToolAdapter[];
  readonly memory: MemoryAdapter;
  /** Wraps the seat executor: injection in, caller context tracked. Generic so the guard's types are untouched. */
  wrapSeatModel<I extends FleetSeatInput, R>(fn: (input: I) => Promise<R>): (input: I) => Promise<R>;
  /** Declares the run the next seat calls belong to; the tiers are built lazily on the first call. */
  runStarted(input: RunStartedInput): void;
  /** Ends the run's freeze: memory re-reads on the next run, and the recall is recomputed. */
  runFinished(runId: string): void;
  /** The assembled injection a seat of this run received; the first seat's when `seat` is omitted. */
  preludeFor(runId: string, seat?: string): string | undefined;
  /** Just the STABLE tier of a run: the bytes that must not move between seats or between runs. */
  stablePreludeFor(runId: string): string | undefined;
  /** The measured assembly for one seat: tier sizes, token estimate, what the ceiling dropped. */
  contextFor(runId: string, seat: string): AssembledContext | undefined;
  /** Installs (or replaces) the sink that receives `context_pressure`; the orchestrator bridges it to the bus. */
  setNoticeSink(sink: (notice: ContextNotice) => void): void;
  /**
   * [C5] The run's event stream, for the two things a prelude cannot learn from the store: which
   * steps failed (they become `[failure]` entries under the brain) and what each step's tool calls
   * were derived from. A surface composes it into `createOrchestrator({ traceSink })`; it is
   * synchronous, swallows its own errors and never fails a run.
   */
  traceSink(event: OrcEvent): void;
  /**
   * [C5] Records one failure directly, for a caller that is not on the event stream. [G2] Refused
   * while the step's own seat call is still running: a note written from a step in flight carries
   * whatever had streamed, and the brain's notes reach the next run.
   */
  stepFailed(record: FailureRecord): boolean;
  /** [G2] True when this process watched the step's seat call not finish: a fragment, not an answer. */
  stepInterrupted(runId: string, stepId: string): boolean;
  /** [C5] What a step's tool calls were derived from, as this process watched them. */
  stepProvenance(runId: string, stepId: string): Provenance;
}

export interface FleetMemoryHookOptions {
  readonly source: FleetMemorySource;
  /** An existing memory adapter (tests), or `profileDir` to build one. */
  readonly memory?: MemoryAdapter;
  readonly profileDir?: string;
  /** Config `memory.blocks` for the adapter built from `profileDir`; the three defaults when omitted. */
  readonly blocks?: readonly MemoryBlock[];
  readonly config?: FleetMemoryConfig;
  readonly embed?: EmbedFn;
  /** `context.ceiling_chars`: the ceiling on the whole assembled injection. */
  readonly ceilingChars?: number;
  /**
   * The active personality's `systemPromptSuffix`. Volatile tier, last block, and the ONLY path by
   * which a personality reaches a model. Absent or blank means no personality block at all.
   */
  readonly personalitySuffix?: string;
  /**
   * The A2.1 seam: workspace context files (`AGENTS.md`, `CLAUDE.md`, `.trent/*.md`) already
   * scanned, trusted and rendered by their own module. Nothing here opens a file.
   */
  readonly workspaceContext?: string;
  /**
   * [C2] The brain (`brain.ts`). Omitted it is built from `profileDir`, which is `brain.enabled`
   * defaulting to true; `false` turns it off entirely and no `brain/` directory is ever created.
   * A hook constructed with a `memory` adapter and no `profileDir` has no brain, because there is
   * no profile to put one in.
   */
  readonly brain?: Brain | false;
  readonly onNotice?: (notice: ContextNotice) => void;
  /**
   * [G2] One step's seat call has settled. The app-memory mirror holds a seat's episodic append
   * until this says the step finished (`app-writes.ts`); `completed` is false when the call threw
   * or the run closed around it.
   */
  readonly onStepSettled?: (settled: StepSettled) => void;
}

interface SeatContext {
  readonly blocks: readonly ContextBlock[];
  readonly assembled: AssembledContext;
}

interface ActiveRun {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
  readonly history?: readonly ConversationTurn[];
  /** The run's frozen view of the company: every seat of this run reads the same rows. */
  readonly source: FleetMemorySource;
  stable?: Promise<readonly ContextBlock[]>;
  readonly seats: Map<string, Promise<SeatContext>>;
  /** One notice per run, whichever seat crosses the ratio first. */
  warned: boolean;
}

/** The session transcript block. Plain roles, oldest first; the new objective is not repeated here. */
export function renderConversation(history: readonly ConversationTurn[]): string {
  if (history.length === 0) return "";
  const lines = history.map((turn) => `${turn.role}: ${turn.content}`);
  return `## Conversation so far (this session, oldest first; the objective above is the newest line)\n${lines.join("\n\n")}`;
}

function block(tier: ContextBlock["tier"], name: string, text: string): ContextBlock {
  return { tier, name, text };
}

function pressureDetail(runId: string, seat: string, assembled: AssembledContext): string {
  const percent = Math.round(assembled.pressure * 100);
  const trimmed = assembled.dropped.length === 0 ? "nothing trimmed" : `trimmed: ${assembled.dropped.join(", ")}`;
  return (
    `context pressure on run ${runId}, seat ${seat}: the wrapper's injection is ${assembled.chars} chars ` +
    `(~${assembled.estimatedTokens} tokens, estimated) against a ${assembled.ceilingChars}-char ceiling, ` +
    `${percent} percent; ${trimmed}`
  );
}

export function createFleetMemoryHook(options: FleetMemoryHookOptions): FleetMemoryHook {
  const config = options.config ?? DEFAULT_FLEET_MEMORY_CONFIG;
  const ceilingChars =
    typeof options.ceilingChars === "number" && Number.isFinite(options.ceilingChars) && options.ceilingChars > 0
      ? Math.trunc(options.ceilingChars)
      : DEFAULT_CONTEXT_CEILING_CHARS;
  let caller: { seat: string; delegated: boolean } = { seat: "", delegated: false };
  let notify: ((notice: ContextNotice) => void) | undefined = options.onNotice;
  const memory =
    options.memory ??
    (() => {
      if (!options.profileDir) throw new Error("createFleetMemoryHook needs `memory` or `profileDir`");
      return createMemoryAdapter({ profileDir: options.profileDir, blocks: options.blocks });
    })();
  memory.bindCallerContext(() => ({ delegated: caller.delegated }));
  // [G2] What this process watched being stopped (`source.ts`). `fleet_search` renders whatever
  // steps it is handed, so it reads the PRUNED view: a stopped turn's output is not a hit. Recall
  // reads the tagged view, because it reports what it kept.
  const interrupted = createInterruptionTracker(options.onStepSettled);
  const search = createFleetSearchAdapter({
    source: guardInterrupted(options.source, interrupted.view, { drop: true }),
    config,
    seat: () => caller.seat || undefined,
  });

  // [C2] The brain. Constructing it opens nothing: `ensure()` runs on the first stable tier of the
  // first run, so a profile that never runs anything never gets a `brain/` directory.
  const brain: Brain | undefined =
    options.brain === false
      ? undefined
      : (options.brain ?? (options.profileDir === undefined ? undefined : createBrain({ profileDir: options.profileDir })));
  const brainRead = brain === undefined ? undefined : createBrainReadAdapter({ profileDir: brain.profileDir });
  /** True once the brain has been prepared for this process; migration is idempotent regardless. */
  let brainReady = false;

  /**
   * Create the layout, run the one-time block migration, and render the block. The brain is
   * ADVISORY: anything that throws here — a read-only profile, a wedged lock, a git that vanished
   * mid-run — degrades to no brain block rather than failing the run.
   */
  function brainBlock(): ContextBlock | undefined {
    if (brain === undefined) return undefined;
    try {
      if (!brainReady) {
        brain.ensure();
        migrateBlocksToBrain({ profileDir: brain.profileDir, brain, blocks: memory.blocks });
        brainReady = true;
      }
      const text = renderBrainBlock({ brain, excludeSystemFiles: memory.blocks.map((b) => brainSystemFileFor(b)) });
      return text === "" ? undefined : block("stable", CONTEXT_BLOCKS.brain, text);
    } catch {
      return undefined;
    }
  }

  /**
   * [C5] What each step's tool calls were derived from, keyed `<runId> <stepId>`. The app's step
   * rows have no provenance column and `apps/web` is read-only, so the tag lives here and is
   * handed back to recall by `withStepProvenance`.
   */
  const stepTags = new Map<string, Provenance>();

  /** Runs in flight, by id; the wrapper drains one job at a time but keeps the map general. */
  const runs = new Map<string, ActiveRun>();
  const observeStep = createStepObserver({
    brain,
    objectiveFor: (runId) => runs.get(runId)?.objective,
    tagStep: (runId, stepId, provenance) => {
      const key = `${runId} ${stepId}`;
      stepTags.set(key, worstProvenance([stepTags.get(key) ?? "trusted", provenance]));
    },
  });
  const assembled = new Map<string, SeatContext>();
  const stableText = new Map<string, string>();
  const firstSeat = new Map<string, string>();
  let current: ActiveRun | undefined;

  /** Tier 1. No seat, no objective, no turn: the same bytes for every seat and every run. */
  async function buildStable(run: ActiveRun): Promise<readonly ContextBlock[]> {
    // The brain goes first because the migration is what decides where the memory blocks' bytes
    // are: `memoryPath()` follows a migrated block into `brain/system/`, and the frozen snapshot
    // below must read whichever file is now the block.
    const brainTier = brainBlock();
    const blocks: ContextBlock[] = [
      block("stable", CONTEXT_BLOCKS.companyMemory, `## Company memory (shared by every seat; writes land next run)\n${memory.frozenSnapshot()}`),
    ];
    if (brainTier) blocks.push(brainTier);
    if (options.workspaceContext !== undefined && options.workspaceContext.trim() !== "") {
      blocks.push(block("stable", CONTEXT_BLOCKS.workspace, options.workspaceContext));
    }
    if (run.source.improve) {
      const org = await listSharedSkills(run.source.improve, run.companyId, ORG_TIER_AGENT);
      const index = renderSharedSkillsIndex(org, '## Shared skills, org tier (fleet_skill_view {"skill": "<task type>"} for the body)');
      if (index) blocks.push(block("stable", CONTEXT_BLOCKS.orgSkills, index));
    }
    return blocks;
  }

  /** Tier 2. This objective, this seat. */
  async function buildSeatBlocks(run: ActiveRun, seat: string): Promise<ContextBlock[]> {
    const blocks: ContextBlock[] = [];
    if (run.source.improve) {
      const own = (await listSharedSkills(run.source.improve, run.companyId, seat)).filter((s) => s.tier === "own");
      const index = renderSharedSkillsIndex(own, `## Shared skills, ${seat} only (fleet_skill_view {"skill": "<task type>"} for the body)`);
      if (index) blocks.push(block("context", CONTEXT_BLOCKS.seatSkills, index));
    }
    // [C2] What this seat's brain holds about this objective: standing decisions, episodic notes
    // and this seat's own notes. Advisory and never fatal, like the block above it.
    if (brain !== undefined) {
      try {
        const fromBrain = await recallFromBrain({
          profileDir: brain.profileDir,
          brain,
          seat,
          objective: run.objective,
          config,
          ...(options.embed === undefined ? {} : { embed: options.embed }),
        });
        if (fromBrain.block) blocks.push(block("context", CONTEXT_BLOCKS.brainRecall, fromBrain.block));
      } catch {
        // Recall is an index, not a truth: an unreadable one costs relevance, never a run.
      }
    }
    const tagged = withStepProvenance(run.source, (runId, stepId) => stepTags.get(`${runId} ${stepId}`));
    const recall = await recallForObjective(guardInterrupted(tagged, interrupted.view), {
      companyId: run.companyId,
      seat,
      objective: run.objective,
      excludeRunId: run.runId,
      config,
      ...(options.embed === undefined ? {} : { embed: options.embed }),
    });
    if (recall.block) blocks.push(block("context", CONTEXT_BLOCKS.recall, recall.block));
    // [C5] Failures last in the CONTEXT tier, which is also last to be trimmed: the block is the
    // smallest thing here and the only one that says what NOT to try again (audit 3.5).
    if (brain !== undefined) {
      try {
        const failures = await recallFailures({
          brain,
          objective: run.objective,
          excludeRunId: run.runId,
          config,
          ...(options.embed === undefined ? {} : { embed: options.embed }),
        });
        if (failures.block) blocks.push(block("context", FAILURES_BLOCK, failures.block));
      } catch {
        // Advisory, like every other brain read: an unreadable channel costs a warning, never a run.
      }
    }
    return blocks;
  }

  /** Tier 3. Oldest trimmable last: the transcript goes before the one-line personality suffix. */
  function buildVolatile(run: ActiveRun): ContextBlock[] {
    const blocks: ContextBlock[] = [];
    const conversation = renderConversation(run.history ?? []);
    if (conversation) blocks.push(block("volatile", CONTEXT_BLOCKS.conversation, conversation));
    const suffix = options.personalitySuffix?.trim();
    if (suffix) blocks.push(block("volatile", CONTEXT_BLOCKS.personality, suffix));
    return blocks;
  }

  async function buildFor(run: ActiveRun, seat: string): Promise<SeatContext> {
    run.stable ??= buildStable(run);
    const stable = await run.stable;
    stableText.set(run.runId, stable.map((b) => b.text).join("\n\n"));
    const blocks = [...stable, ...(await buildSeatBlocks(run, seat)), ...buildVolatile(run)];
    const context = assembleContext(blocks, { ceilingChars });
    assembled.set(`${run.runId} ${seat}`, { blocks, assembled: context });
    if (!firstSeat.has(run.runId)) firstSeat.set(run.runId, seat);
    if (!run.warned && context.pressure >= PRESSURE_WARNING_RATIO) {
      run.warned = true;
      notify?.({
        kind: "context_pressure",
        runId: run.runId,
        seat,
        chars: context.chars,
        estimatedTokens: estimateTokens(context.chars),
        ceilingChars: context.ceilingChars,
        ratio: context.pressure,
        dropped: context.dropped,
        detail: pressureDetail(run.runId, seat, context),
      });
    }
    return { blocks, assembled: context };
  }

  function runFor(input: FleetSeatInput): ActiveRun | undefined {
    if (runs.size === 1) return current;
    const objective = (input.subtask.contextBundle as { overallObjective?: string } | undefined)?.overallObjective;
    for (const run of runs.values()) {
      if (run.companyId === (input.companyId ?? run.companyId) && (objective === undefined || run.objective === objective)) return run;
    }
    return current;
  }

  return {
    adapters: brainRead === undefined ? [memory, search] : [memory, search, brainRead],
    memory,
    wrapSeatModel(fn) {
      return async (input) => {
        caller = { seat: input.subtask.seat, delegated: isDelegatedObjective(input.subtask.objective ?? "") };
        const run = runFor(input);
        if (!run) return fn(input);
        const seat = input.subtask.seat;
        let pending = run.seats.get(seat);
        if (!pending) {
          pending = buildFor(run, seat);
          run.seats.set(seat, pending);
        }
        const context = await pending;
        const dynamicPrompt = [input.dynamicPrompt, context.assembled.text].filter((s): s is string => !!s && s.trim() !== "").join("\n\n");
        const stepId = input.subtask.id;
        interrupted.begin(run.runId, stepId, seat);
        try {
          const result = await fn({ ...input, dynamicPrompt });
          interrupted.settle(run.runId, stepId, true);
          return result;
        } catch (error) {
          interrupted.settle(run.runId, stepId, false);
          throw error;
        }
      };
    },
    runStarted(input) {
      const run: ActiveRun = {
        runId: input.runId,
        companyId: input.companyId,
        objective: input.objective,
        ...(input.history === undefined ? {} : { history: input.history }),
        source: freezeFleetSource(options.source),
        seats: new Map(),
        warned: false,
      };
      runs.set(input.runId, run);
      current = run;
    },
    runFinished(runId) {
      // [G2] A step still running when the run closed is a step the run was stopped around: Ctrl+C
      // leaves the drain loop and the seat call lands its row in the background. Marked first, so
      // the next run recalls neither the step nor the run.
      interrupted.closeRun(runId);
      runs.delete(runId);
      if (current?.runId === runId) current = runs.values().next().value;
      // Writes made during this run become visible to the next one.
      memory.thaw();
    },
    preludeFor(runId, seat) {
      const wanted = seat ?? firstSeat.get(runId);
      if (wanted === undefined) return undefined;
      return assembled.get(`${runId} ${wanted}`)?.assembled.text;
    },
    stablePreludeFor: (runId) => stableText.get(runId),
    contextFor: (runId, seat) => assembled.get(`${runId} ${seat}`)?.assembled,
    setNoticeSink(sink) {
      notify = sink;
    },
    stepFailed: (record) => {
      // [G2] Refused, not queued: the step's own end is where the failure channel already writes.
      if (record.runId !== undefined && record.stepId !== undefined && interrupted.running(record.runId, record.stepId)) return false;
      return writeFailure(brain, record);
    },
    stepInterrupted: (runId, stepId) => interrupted.view.step(runId, stepId) || interrupted.view.run(runId),
    stepProvenance: (runId, stepId) => stepTags.get(`${runId} ${stepId}`) ?? "trusted",
    traceSink: observeStep,
  };
}
