/**
 * The one object the orchestrator wrapper takes (`createOrchestrator({ fleetMemory })`): it owns
 * the shared `memory` adapter and the `fleet_search` adapter, wraps the seat executor so EVERY
 * seat's prompt carries the same frozen prelude for the run, and tracks which step is calling a
 * tool so a delegated child's memory write is refused while its read is served.
 *
 * Prelude, per run, computed at the first seat call and then byte-identical for the rest of the
 * run (Hermes `memory_tool_store.py:347-350`: a stable prefix caches; a moving one does not):
 *   1. every named memory block (MEMORY.md / USER.md / COMPANY.md by default, config
 *      `memory.blocks`), the company's shared memory (frozen snapshot);
 *   2. the shared skills index (org tier + this seat's own — the one per-seat part, so it is
 *      rendered for the seat that calls first and stays; the body is a tool call away);
 *   3. the cross-agent recall block, bounded by `recallBudgetChars`.
 * It is appended to `dynamicPrompt`, the seat prompt field the pipeline already reserves for
 * per-step context (`model-gateway.ts` `buildSeatUserPrompt`), after the pipeline's own text.
 */

import { createMemoryAdapter, type MemoryAdapter, type MemoryBlock } from "../tools/memory/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import type { EmbedFn } from "./lexical.js";
import { recallForObjective } from "./recall.js";
import { createFleetSearchAdapter } from "./search.js";
import { listSharedSkills, renderSharedSkillsIndex } from "./shared-skills.js";
import { isDelegatedObjective, type FleetMemorySource } from "./source.js";

/**
 * The slice of the pipeline's `SeatModelExecutionInput` the hook reads and extends. `objective`
 * is optional only because the seat guard's structural slice omits it; the pipeline always sets it.
 */
export interface FleetSeatInput {
  readonly companyId?: string;
  readonly subtask: { readonly id: string; readonly seat: string; readonly objective?: string; readonly contextBundle?: unknown };
  readonly dynamicPrompt?: string;
}

export interface RunStartedInput {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
}

export interface FleetMemoryHook {
  /** `memory` and `fleet_search`, to be wired into every seat like any toolset. */
  readonly adapters: readonly TrentToolAdapter[];
  readonly memory: MemoryAdapter;
  /** Wraps the seat executor: prelude in, caller context tracked. Generic so the guard's types are untouched. */
  wrapSeatModel<I extends FleetSeatInput, R>(fn: (input: I) => Promise<R>): (input: I) => Promise<R>;
  /** Declares the run the next seat calls belong to; the prelude is built lazily on the first call. */
  runStarted(input: RunStartedInput): void;
  /** Ends the run's freeze: memory re-reads on the next run, and the recall is recomputed. */
  runFinished(runId: string): void;
  /** The frozen prelude of a run, once a seat has called; for surfaces and tests. */
  preludeFor(runId: string): string | undefined;
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
}

interface ActiveRun {
  readonly runId: string;
  readonly companyId: string;
  readonly objective: string;
  prelude?: Promise<string>;
}

export function createFleetMemoryHook(options: FleetMemoryHookOptions): FleetMemoryHook {
  const config = options.config ?? DEFAULT_FLEET_MEMORY_CONFIG;
  let caller: { seat: string; delegated: boolean } = { seat: "", delegated: false };
  const memory =
    options.memory ??
    (() => {
      if (!options.profileDir) throw new Error("createFleetMemoryHook needs `memory` or `profileDir`");
      return createMemoryAdapter({ profileDir: options.profileDir, blocks: options.blocks });
    })();
  memory.bindCallerContext(() => ({ delegated: caller.delegated }));
  const search = createFleetSearchAdapter({ source: options.source, config, seat: () => caller.seat || undefined });

  /** Runs in flight, by id; the wrapper drains one job at a time but keeps the map general. */
  const runs = new Map<string, ActiveRun>();
  const frozen = new Map<string, string>();
  let current: ActiveRun | undefined;

  async function buildPrelude(run: ActiveRun, seat: string): Promise<string> {
    const parts: string[] = [`## Company memory (shared by every seat; writes land next run)\n${memory.frozenSnapshot()}`];
    if (options.source.improve) {
      const index = renderSharedSkillsIndex(await listSharedSkills(options.source.improve, run.companyId, seat));
      if (index) parts.push(index);
    }
    const recall = await recallForObjective(options.source, {
      companyId: run.companyId,
      seat,
      objective: run.objective,
      excludeRunId: run.runId,
      config,
      embed: options.embed,
    });
    if (recall.block) parts.push(recall.block);
    return parts.join("\n\n");
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
    adapters: [memory, search],
    memory,
    wrapSeatModel(fn) {
      return async (input) => {
        caller = { seat: input.subtask.seat, delegated: isDelegatedObjective(input.subtask.objective ?? "") };
        const run = runFor(input);
        if (!run) return fn(input);
        run.prelude ??= buildPrelude(run, input.subtask.seat).then((text) => {
          frozen.set(run.runId, text);
          return text;
        });
        const prelude = await run.prelude;
        const dynamicPrompt = [input.dynamicPrompt, prelude].filter((s): s is string => !!s && s.trim() !== "").join("\n\n");
        return fn({ ...input, dynamicPrompt });
      };
    },
    runStarted(input) {
      const run: ActiveRun = { runId: input.runId, companyId: input.companyId, objective: input.objective };
      runs.set(input.runId, run);
      current = run;
    },
    runFinished(runId) {
      runs.delete(runId);
      if (current?.runId === runId) current = runs.values().next().value;
      // Writes made during this run become visible to the next one.
      memory.thaw();
    },
    preludeFor: (runId) => frozen.get(runId),
  };
}
