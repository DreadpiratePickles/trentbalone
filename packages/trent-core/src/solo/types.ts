/**
 * [S1] Solo mode's public shapes: one agent, one conversation, one tool loop, no seats.
 *
 * The runner is a second implementation of the `AgentRunner` port (`../agent-runner/index.ts`), so
 * every surface that already consumes orchestrator events (the REPL, the TUI, `trent run`, the
 * gateway, cron, A2A, ACP) consumes a solo run unchanged. Every dependency arrives as a narrow port:
 * the loop owns no provider, no file, no clock and no ledger of its own
 * (02_plan/output/solo-harness-design-2026-09-26.md, "The loop").
 */
import type { AgentRunInput, AgentRunner } from "../agent-runner/index.js";
import type { ContextBlock } from "../fleet-memory/tiers.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import type { RunModelCall } from "../orchestrator/run-hooks.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { HumanAnswers } from "../tools/human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";

/** The one seat a solo run has. Every frame, ledger row and approval row names it. */
export const SOLO_SEAT = "trent";

/** Tool calls one run may make before it is stopped with a verdict naming the cap. */
export const DEFAULT_SOLO_MAX_TOOL_CALLS = 25;

/** How many times the SAME call may fail (or be refused) before the run stops on it. */
export const SOLO_MISUSE_REPEATS = 3;

/** The gateway slice the loop calls. `ModelGateway` satisfies it. */
export interface SoloGateway {
  complete(request: GatewayStreamRequest): Promise<GatewayCompletion>;
}

/** The tool build slice the loop reads: the adapters, already wrapped in the gate chain. `TrentToolBuild` satisfies it. */
export interface SoloTools {
  readonly adapters: readonly TrentToolAdapter[];
}

export type SoloMessageRole = "user" | "assistant" | "system" | "tool";

/**
 * One message of the session's conversation, as the loop reads and writes it. `system` is carried
 * for exactly one thing, a compaction summary (`sessions/compaction.ts`); the loop never writes one.
 */
export interface SoloMessage {
  readonly role: SoloMessageRole;
  readonly content: string;
  /** The run that wrote it. Absent on a message the surface seeded. */
  readonly runId?: string;
  /** On a `tool` message: the record exactly as the gated adapter returned it. */
  readonly record?: ToolCallRecord;
}

/**
 * The session the conversation lives in. `history()` is what the model may be told, oldest first,
 * AFTER compaction: the adapter that backs this port applies `compactSession`, not the loop.
 */
export interface SoloSession {
  history(): Promise<readonly SoloMessage[]>;
  append(messages: readonly SoloMessage[]): Promise<void>;
}

export interface SoloMemoryRequest {
  readonly runId: string;
  readonly objective: string;
  readonly history: readonly SoloMessage[];
}

/** The fleet-memory tiers for one turn (`fleet-memory/tiers.ts`): stable goes in the system prompt, context after the history. */
export interface SoloMemoryTiers {
  readonly stable: readonly ContextBlock[];
  readonly context: readonly ContextBlock[];
}

export type SoloMemory = (request: SoloMemoryRequest) => Promise<SoloMemoryTiers>;

/** One model call as the meter prices it: `orchestrator/run-hooks.ts` `RunModelCall`, seat `trent`, with the step. */
export type SoloModelCall = RunModelCall;

/**
 * The spend meter. `record` returns the whole cents newly due for the call, which is what the
 * step's `step_end` charges; `stopReason` is asked before every model call and a reason stops the
 * run before another token is bought. `createRunLedgerMeter` (`./meter.ts`) is the real one.
 */
export interface SoloMeter {
  open?(runId: string, objective: string): void;
  record(runId: string, call: SoloModelCall): number;
  stopReason?(runId: string): string | undefined;
  close?(runId: string): void;
}

/** The agent-write ledger: one run is one turn (`checkpoints/`, E1). */
export interface SoloCheckpoints {
  beginTurn(): void;
}

export interface SoloConfig {
  /** Default {@link DEFAULT_SOLO_MAX_TOOL_CALLS}. */
  readonly maxToolCalls?: number;
  /** A pin: sent as the request's explicit `model`, so the gateway's pin policy applies (`call-policy.ts`). */
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** `context.ceiling_chars` for the injected tiers; the stable tier is never trimmed (`tiers.ts`). */
  readonly ceilingChars?: number;
}

export interface SoloRunnerDeps {
  readonly gateway: SoloGateway;
  readonly tools: SoloTools;
  readonly session: SoloSession;
  readonly memory: SoloMemory;
  readonly meter: SoloMeter;
  readonly checkpoints?: SoloCheckpoints;
  readonly now?: () => Date;
  readonly config?: SoloConfig;
  /** Where `brain/system/solo.md` (the persona) is read from. Absent means the default persona. */
  readonly profileDir?: string;
  /** Workspace facts for the context tier: the directory the tools work in. */
  readonly workspace?: string;
  /** Handed to every adapter call as `{ companyId }`, as the seat loop does. */
  readonly companyId?: string;
  /** Where an `ask_human` answer waits for the replay. Defaults to the process-wide registry the adapter reads. */
  readonly humanAnswers?: HumanAnswers;
  /** Test seam for run ids. */
  readonly newId?: (prefix: string) => string;
}

/** A run parked on a held call, as a surface lists it. */
export interface SoloParkedCall {
  readonly runId: string;
  readonly stepId: string;
  readonly adapter: string;
  readonly action: string;
  /** The held record's own summary: what the human is being asked. */
  readonly summary: string;
}

/**
 * The solo runner. `approve`/`reject`/`answer` have the orchestrator's signatures, so it is the
 * `ApprovalTarget` the REPL (`bindApprovalAnswers`) and the gateway (`linkRunApprovals`) already
 * take. A decision that arrives while the stream is still being read continues the same stream; a
 * later one is continued by `resume`.
 */
export interface SoloRunner extends AgentRunner {
  run(input: AgentRunInput): AsyncIterable<OrcEvent>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
  answer(runId: string, stepId: string, text: string): Promise<boolean>;
  resume(runId: string, input?: { readonly signal?: AbortSignal }): AsyncIterable<OrcEvent>;
  parked(): readonly SoloParkedCall[];
}
