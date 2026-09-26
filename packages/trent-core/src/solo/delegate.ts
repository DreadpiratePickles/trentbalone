/**
 * [S3] `delegate_task` in solo: the child side (item 4; council A11, C10, chair S3.4).
 *
 * A solo run delegates to a CHILD RUN, never to seats (the design: "no nested seats"):
 *   solo   a child solo runner on its own conversation: a new session of the parent's store, or one in
 *          memory for a one-off parent. It shares the parent's gateway, memory tiers, skills and gated
 *          tools, with four differences: every hold is refused (nobody can approve one for a child,
 *          chair S3.4); it is not offered `ask_human` or `clarify`; shared writes (memory, brain, skills)
 *          are refused, the fleet's rule for a delegated step ("its memory writes come back as blocked
 *          for you to make", the tool's own schema); and its budget is a slice of the parent's (the
 *          parent side, `delegate-route.ts`). It starts from the parent's taint, so a secret or a page
 *          the parent read still holds its calls, and what it reads goes back up.
 *   fleet  a child fleet run through the runtime's fleet runner (`agent.solo.delegate: fleet`). A fleet
 *          run's policy ring is its own run's and cannot be seeded, so the parent refuses it while the
 *          conversation is tainted; its calls are classified back into the parent's taint afterwards.
 * A solo child's frames go to the runtime's sinks (bus hooks, traces, the audit rows), as every solo
 * run's do; a fleet child's already reach them through the orchestrator.
 * The child's objective never starts with `[delegated]`: the fleet-memory hook reads that prefix as
 * "the caller is a delegated step" and would keep the flag for the parent's calls after the child.
 */
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import { adapterProvenance, isSharedWriteTool, isSkillWriteTool, type SessionTaintSnapshot } from "../governance/provenance.js";
import { classifyCall } from "../governance/policy-rules.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { record as toRecord } from "../tools/action.js";
import type { DelegateResult } from "../tools/delegate/types.js";
import { CARD_ADAPTER_NAMES } from "../tools/human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { applyHoldPolicy } from "./hold-policy.js";
import { EMPTY_SOLO_STATE, loadSoloState } from "./park.js";
import type { SoloFrameSink } from "./router.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import type { SoloMeter, SoloRunner, SoloRunnerDeps, SoloSession, SoloSessionState, SoloStateStore } from "./types.js";

export type SoloDelegateMode = "solo" | "fleet" | "off";
export const SOLO_DELEGATE_MODES: readonly SoloDelegateMode[] = ["solo", "fleet", "off"];
/** `agent.solo.max_delegation_depth`: a child, and the child's child (`orchestrator/delegate-port.ts` caps the fleet the same). */
export const DEFAULT_SOLO_MAX_DELEGATION_DEPTH = 2;

/** One delegated task, as the parent's route hands it over. */
export interface SoloChildRequest {
  readonly task: string;
  readonly context?: string;
  readonly agent?: string;
  /** 1 for a child, 2 for a grandchild. */
  readonly depth: number;
  /** The parent's tool calls left: the child's cap. */
  readonly maxToolCalls: number;
  /** The parent's meter, sliced: the child's calls land on the parent's run and stop at the slice. */
  readonly meter: SoloMeter;
  /** The parent's conversation taint when the child starts. */
  readonly taint: SessionTaintSnapshot;
  readonly parentRunId: string;
  readonly parentSessionId?: string;
  readonly signal?: AbortSignal;
}

export interface SoloChildOutcome {
  readonly status: DelegateResult["status"];
  readonly output: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly costCents: number;
  readonly tokens: number;
  readonly callsMade: number;
  /** The child's taint when it ended: merged into the parent's conversation. */
  readonly taint: SessionTaintSnapshot;
}

/** What `delegate_task` does in one conversation. */
export interface SoloDelegation {
  readonly mode: SoloDelegateMode;
  readonly maxDepth: number;
  run(request: SoloChildRequest): Promise<SoloChildOutcome>;
}

export interface SoloChildSpec {
  readonly objective: string;
  readonly depth: number;
  readonly maxToolCalls: number;
  readonly meter: SoloMeter;
  readonly taint: SessionTaintSnapshot;
  readonly parentRunId: string;
  readonly parentSessionId?: string;
}

export interface SoloChild {
  readonly runner: SoloRunner;
  /** The child's conversation taint after its run. */
  taint(): SessionTaintSnapshot;
  readonly sessionId?: string;
}

export interface SoloDelegationOptions {
  readonly mode?: SoloDelegateMode;
  readonly maxDepth?: number;
  readonly createChild?: (spec: SoloChildSpec) => SoloChild;
  /** A child fleet run's frames, for `mode: fleet`. */
  readonly fleet?: (objective: string, signal?: AbortSignal) => AsyncIterable<OrcEvent>;
  readonly sinks?: readonly SoloFrameSink[];
}

const positive = (value: number | undefined): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const whole = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

/** The child's objective: the task, the context it was given, and who it works for. */
export function childObjective(task: string, context?: string): string {
  return [
    task.trim(),
    ...(context === undefined || context.trim() === "" ? [] : ["", "Context from the agent that delegated this task:", context.trim()]),
    "",
    "You are doing this for another agent, not for a person: nobody can answer a question or approve a held call. Finish with the result it asked for, and say plainly what you could not do.",
  ].join("\n");
}

const READ_ONLY = "a delegated task has read-only shared memory, so nothing was written. Put the fact in your answer; the agent that delegated this task decides whether to record it.";

function readOnlyShared(adapter: TrentToolAdapter): TrentToolAdapter {
  const execute = async (action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> => {
    const tool = toolNameOf(action);
    if (isSharedWriteTool(adapter.name, tool) || isSkillWriteTool(tool)) return toRecord(adapter.name, action, "blocked", `${adapter.name}: ${READ_ONLY}`);
    return adapter.execute(action, payload);
  };
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "execute") return execute;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The parent's gated adapters as a child gets them: holds refused, no human tools, shared writes refused. */
export function childAdapters(adapters: readonly TrentToolAdapter[], surface = "delegated task"): TrentToolAdapter[] {
  return applyHoldPolicy(adapters.filter((adapter) => !CARD_ADAPTER_NAMES.includes(adapter.name)), "deny", surface).map(readOnlyShared);
}

/** An in-memory state store that starts from the parent's taint. */
export function seededState(taint: SessionTaintSnapshot): SoloStateStore {
  let saved: SoloSessionState = { ...EMPTY_SOLO_STATE, taint };
  return {
    load: () => JSON.parse(JSON.stringify(saved)) as unknown,
    save: (state) => void (saved = JSON.parse(JSON.stringify(state)) as SoloSessionState),
  };
}

function argsOf(action: string): unknown {
  const brace = action.indexOf("{");
  if (brace === -1) return {};
  try {
    return JSON.parse(action.slice(brace)) as unknown;
  } catch {
    return {};
  }
}

/** A fleet child's calls, classified the way the policy ring classifies a call, added to a taint. */
export function taintWithCalls(taint: SessionTaintSnapshot, records: readonly ToolCallRecord[], at: number): SessionTaintSnapshot {
  const calls = records.map((call) => {
    const tool = toolNameOf(call.action);
    return { tool: tool || call.adapter, classes: classifyCall({ adapter: call.adapter, scopes: [], tool, args: argsOf(call.action) }), at };
  });
  const untrusted = records.filter((call) => call.provenance === "untrusted" || adapterProvenance(call.adapter, toolNameOf(call.action)) === "untrusted").map((call) => toolNameOf(call.action) || call.adapter);
  return { calls: [...taint.calls, ...calls], sources: [...new Set([...taint.sources, ...untrusted])] };
}

type Folded = Omit<SoloChildOutcome, "taint" | "sessionId">;

/** A child run's frames folded into its outcome; every frame shared with the sinks on the way. */
async function fold(stream: AsyncIterable<OrcEvent>, sinks: readonly SoloFrameSink[]): Promise<Folded> {
  let runId: string | undefined;
  const byStep = new Map<string, ToolCallRecord[]>();
  let costCents = 0;
  let tokens = 0;
  let status: DelegateResult["status"] = "failed";
  let output = "the delegated run ended without an answer";
  try {
    for await (const event of stream) {
      for (const sink of sinks) {
        try {
          sink.sink(event);
        } catch {
          // An observer that throws must not end the child it watches.
        }
      }
      if (runId === undefined && event.runId !== "") runId = event.runId;
      const step = event.step as { id?: string; toolCalls?: ToolCallRecord[]; costCents?: number; tokens?: number } | undefined;
      if (event.kind === "step_output" && Array.isArray(step?.toolCalls)) byStep.set(step.id ?? "", [...step.toolCalls]);
      if (event.kind === "step_end") {
        costCents += whole(step?.costCents);
        tokens += whole(step?.tokens);
      }
      if (event.kind === "run_done") [status, output] = ["completed", event.run?.summary ?? ""];
      if (event.kind === "run_failed") [status, output] = ["failed", event.detail ?? event.run?.summary ?? "the delegated run failed"];
      if (event.kind === "run_cancelled") [status, output] = ["failed", event.detail ?? "the delegated run was cancelled"];
      if (event.kind === "run_awaiting_approval") [status, output] = ["blocked", `the delegated run is waiting on approval: ${event.detail ?? "a held call"}. It is decided with trent approvals, not here.`];
    }
  } finally {
    for (const sink of sinks) await sink.flush?.().catch(() => undefined);
  }
  const toolCalls = [...byStep.values()].flat();
  return { status, output, ...(runId === undefined ? {} : { runId }), toolCalls, costCents, tokens, callsMade: toolCalls.length };
}

export function createSoloDelegation(options: SoloDelegationOptions): SoloDelegation {
  const sinks = options.sinks ?? [];
  const failed = (request: SoloChildRequest, output: string): SoloChildOutcome => ({ status: "failed", output, toolCalls: [], costCents: 0, tokens: 0, callsMade: 0, taint: request.taint });
  return {
    mode: options.mode ?? "solo",
    maxDepth: positive(options.maxDepth) ?? DEFAULT_SOLO_MAX_DELEGATION_DEPTH,
    async run(request) {
      const objective = childObjective(request.task, request.context);
      if (options.mode === "fleet") {
        if (options.fleet === undefined) return failed(request, "delegate_task: agent.solo.delegate is fleet, and this surface has no fleet runner, so nothing was delegated.");
        const since = Date.now();
        // No sinks: the orchestrator already hands a fleet run's frames to the runtime's hooks.
        const folded = await fold(options.fleet(objective, request.signal), []);
        return { ...folded, taint: taintWithCalls(request.taint, folded.toolCalls, since) };
      }
      if (options.createChild === undefined) return failed(request, "delegate_task: no child runner is configured on this surface, so nothing was delegated.");
      const child = options.createChild({
        objective,
        depth: request.depth,
        maxToolCalls: request.maxToolCalls,
        meter: request.meter,
        taint: request.taint,
        parentRunId: request.parentRunId,
        ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
      });
      const folded = await fold(child.runner.run({ objective, ...(request.signal === undefined ? {} : { signal: request.signal }) }), sinks);
      return { ...folded, ...(child.sessionId === undefined ? {} : { sessionId: child.sessionId }), taint: child.taint() };
    },
  };
}

/** What a child shares with its parent; the rest (session, meter, state, depth, tools) is the child's own. */
export type SoloChildBase = Pick<SoloRunnerDeps, "gateway" | "memory" | "skills" | "profileDir" | "workspace" | "companyId" | "now" | "newId" | "config" | "compaction" | "humanAnswers">;

/** Where a child's conversation lives. */
export interface SoloChildConversation {
  readonly session: SoloSession;
  readonly state: SoloStateStore;
  readonly sessionId?: string;
}

export interface SoloChildFactoryOptions {
  readonly base: SoloChildBase;
  /** The parent's adapters, gated; the child gets them with holds refused and no human tools. */
  readonly adapters: readonly TrentToolAdapter[];
  /** Absent: a conversation in memory. */
  readonly conversation?: (spec: SoloChildSpec) => SoloChildConversation;
  /** The port the child's own `delegate_task` uses: the same one, one level deeper. */
  readonly delegation: () => SoloDelegation;
}

/** Builds each child runner: its own conversation seeded with the parent's taint, the child's tools, the slice. */
export function soloChildFactory(options: SoloChildFactoryOptions): (spec: SoloChildSpec) => SoloChild {
  const adapters = childAdapters(options.adapters);
  return (spec) => {
    const conversation = options.conversation?.(spec) ?? { session: memorySoloSession(), state: seededState(spec.taint) };
    // A session store's sidecar starts empty: the child's taint is the parent's from its first call on.
    conversation.state.save({ ...EMPTY_SOLO_STATE, taint: spec.taint });
    const runner = createSoloRunner({
      ...options.base,
      tools: { adapters },
      session: conversation.session,
      state: conversation.state,
      ...(conversation.sessionId === undefined ? {} : { sessionId: conversation.sessionId }),
      meter: spec.meter,
      depth: spec.depth,
      delegation: options.delegation(),
      config: { ...options.base.config, maxToolCalls: spec.maxToolCalls },
    });
    return { runner, taint: () => loadSoloState(conversation.state).taint, ...(conversation.sessionId === undefined ? {} : { sessionId: conversation.sessionId }) };
  };
}
