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
import type { BoundApprovalStore } from "../governance/bound-approvals.js";
import type { SessionTaintSnapshot } from "../governance/provenance.js";
import type { GatewayCompletion, GatewayMessage, GatewayStreamEvent, GatewayStreamRequest } from "../model-gateway/types.js"; // [C13] GatewayStreamEvent
import type { RunModelCall } from "../orchestrator/run-hooks.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { SessionMessage } from "../sessions/schema.js"; // [S3] compaction plans over the stored transcript
import type { SoloCompactionOutcome, SoloCompactionSettings } from "./compaction.js"; // [S3]
import type { SoloDelegation } from "./delegate.js"; // [S3]
import type { SoloSkills } from "./skills.js"; // [S3]
import type { HumanAnswers } from "../tools/human/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";

/** The one seat a solo run has. Every frame, ledger row and approval row names it. */
export const SOLO_SEAT = "trent";

/** Tool calls one run may make before it is stopped with a verdict naming the cap. */
export const DEFAULT_SOLO_MAX_TOOL_CALLS = 25;

/** How many times the SAME call may fail (or be refused) before the run stops on it. */
export const SOLO_MISUSE_REPEATS = 3;

/** [S1.1] C2: what one tool result may put in front of the model, `agent.solo.max_tool_result_chars`. */
export const DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS = 8_000;
export const SOLO_MAX_TOOL_RESULT_CHARS_KEY = "agent.solo.max_tool_result_chars";

/** [S1.1] C2: the output a call reserves in the window when no `maxTokens` is configured. */
export const DEFAULT_SOLO_OUTPUT_RESERVE_TOKENS = 4_096;

/**
 * [S1.1] C1: constrained decoding for the reply, sent as the request's `responseFormat` when set
 * (the OpenAI-compatible `response_format` a local server grammar-constrains: Ollama `format`,
 * llama.cpp `json_schema`, LM Studio, vLLM). `soloResponseFormat` builds the solo turn's envelope.
 */
export type SoloResponseFormat =
  | { readonly type: "json_object" }
  | { readonly type: "json_schema"; readonly json_schema: { readonly name: string; readonly schema: Record<string, unknown>; readonly strict?: boolean } };

/** A request as the loop sends it: the gateway's, plus the constrained-output seam. */
export type SoloGatewayRequest = GatewayStreamRequest & { readonly responseFormat?: SoloResponseFormat };

/** The gateway slice the loop calls. `ModelGateway` satisfies it. */
export interface SoloGateway {
  complete(request: SoloGatewayRequest): Promise<GatewayCompletion>;
  /** [C13] The same call as token frames. When present the turn uses it, so the answer is shown while the model writes. */
  stream?(request: SoloGatewayRequest): AsyncIterable<GatewayStreamEvent>; // [C13]
}

/** The tool build slice the loop reads: the adapters, already wrapped in the gate chain. `TrentToolBuild` satisfies it. */
export interface SoloTools {
  readonly adapters: readonly TrentToolAdapter[];
  /** [S1.1] The bound approval rows the chain files (B6, the restart): which row a hold is, and whether a human decided it. */
  readonly bindings?: BoundApprovalStore;
}

export type SoloMessageRole = "user" | "assistant" | "system" | "tool";

/**
 * One message of the session's conversation, as the loop reads and writes it. `system` is carried
 * for a compaction summary (`sessions/compaction.ts`) and [S3] a note the runner is handed (a
 * `/rollback`); the loop itself never writes one.
 */
export interface SoloMessage {
  readonly role: SoloMessageRole;
  readonly content: string;
  /** The run that wrote it. Absent on a message the surface seeded. */
  readonly runId?: string;
  /** On a `tool` message: the record exactly as the gated adapter returned it. */
  readonly record?: ToolCallRecord;
  /** [S3] On a run's answer: the run's integer cents as its meter charged them, stored as `cost_cents`. */
  readonly costCents?: number;
  /** [S3] On a run's answer: the run's total tokens and the model that answered. */
  readonly tokens?: number;
  readonly model?: string;
}

/**
 * The session the conversation lives in. `history()` is what the model may be told, oldest first,
 * AFTER compaction: the adapter that backs this port applies `compactSession`, not the loop.
 */
export interface SoloSession {
  history(): Promise<readonly SoloMessage[]>;
  append(messages: readonly SoloMessage[]): Promise<void>;
  /** [S3] The stored transcript, ids and metadata included: what compaction plans over. Absent: never compacted. */
  transcript?(): Promise<readonly SessionMessage[]>;
  /** [S3] Replaces the stored transcript with a compacted one. */
  replace?(messages: readonly SessionMessage[]): Promise<void>;
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
  /** [S3] The cents this run may still spend under its per-run cap; undefined when it has none. A delegated child's slice. */
  remaining?(runId: string): number | undefined;
}

/** The agent-write ledger: one run is one turn (`checkpoints/`, E1). */
export interface SoloCheckpoints {
  /** [S3] A10: the runner names its seat, so every row it ledgers is seat `trent`. */
  beginTurn(seat?: string): void;
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
  /** [S1.1] C2: `agent.solo.max_tool_result_chars`; default {@link DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS}. */
  readonly maxToolResultChars?: number;
  /**
   * [S1.1] C2: the model's effective context window in tokens (the local probe's figure). When set, a
   * request whose estimated prompt plus the output reservation (`maxTokens`, else
   * {@link DEFAULT_SOLO_OUTPUT_RESERVE_TOKENS}) exceeds it is refused before it is sent.
   */
  readonly contextWindowTokens?: number;
  /** [S1.1] C1: constrained output, passed through on every request and read back as the envelope. */
  readonly responseFormat?: SoloResponseFormat;
}

/** [S1.1] A run parked on a held call, as it is saved with the session so a restart can continue it. */
export interface SoloParkRecord {
  readonly runId: string;
  readonly stepId: string;
  readonly sessionId?: string;
  readonly objective: string;
  readonly startedAt: string;
  readonly parkedAt: string;
  /** The approval row the hold filed, when it names one. */
  readonly approvalId?: string;
  readonly held: ToolCallRecord;
  /** The held call first, then the calls of the same reply not run yet, by adapter name. */
  readonly pending: ReadonlyArray<{ readonly adapter: string; readonly action: string }>;
  /** The run's own messages from its opening on, exactly as the model was sent them. */
  readonly runMessages: readonly GatewayMessage[];
  /** Results of the reply's earlier calls, not yet handed back to the model. */
  readonly results: readonly string[];
  readonly toolCalls: readonly ToolCallRecord[];
  readonly callsMade: number;
  readonly costCents: number;
  readonly tokens: number;
  readonly model?: string;
  /** Calls a human approved in this run (B6): the same call again is not asked again. */
  readonly approved: ReadonlyArray<{ readonly adapter: string; readonly action: string; readonly approvalId?: string }>;
  /** A decision taken while the run was parked and not yet acted on. */
  readonly decision?: "approved" | "rejected";
}

/** [S1.1] Everything the runner keeps for one conversation between processes. */
export interface SoloSessionState {
  readonly version: 1;
  readonly taint: SessionTaintSnapshot;
  readonly parked: readonly SoloParkRecord[];
  /** [S3] Skills `skill_view` loaded in this conversation: their bodies ride every later turn's context tier. */
  readonly invokedSkills?: readonly string[];
}

/** [S1.1] Where the state lives: `sessionStoreState` (`park.ts`) over the session store's sidecar. */
export interface SoloStateStore {
  /** What `save` last wrote, as read back (validated by the runner); undefined when nothing was. */
  load(): unknown;
  save(state: SoloSessionState): void;
}

/** [S1.1] What happens to the approval row of a park that is abandoned (superseded, or not rebuildable after a restart). */
export interface SoloApprovals {
  /** Marks the row abandoned, with the reason; false when there is no such pending row. */
  abandon(approvalId: string, reason: string): boolean;
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
  /** [S1.1] The surface's session id: named on every park, so a restart knows the conversation. */
  readonly sessionId?: string;
  /** [S1.1] B1 and the restart: the conversation's taint and parks, saved with the session. Absent keeps them in this process only. */
  readonly state?: SoloStateStore;
  /** [S1.1] Absent, an abandoned park's bound row is decided `denied` by "abandoned: <reason>" through `tools.bindings`. */
  readonly approvals?: SoloApprovals;
  /** [S3] The profile's skills: an index in the stable tier, a body `skill_view` loaded in the context tier. */
  readonly skills?: SoloSkills;
  /** [S3] What `delegate_task` does in this conversation: a child solo run (or fleet run), or a refusal. */
  readonly delegation?: SoloDelegation;
  /** [S3] 0 for a conversation, 1 for a delegated child, 2 for its child. */
  readonly depth?: number;
  /** [S3] When the conversation is compacted before a turn; absent, the defaults (`compaction.ts`). */
  readonly compaction?: SoloCompactionSettings;
}

/** A run parked on a held call, as a surface lists it. */
export interface SoloParkedCall {
  readonly runId: string;
  readonly stepId: string;
  readonly adapter: string;
  readonly action: string;
  /** The held record's own summary: what the human is being asked. */
  readonly summary: string;
  /** [S1.1] The approval row the hold filed, when it names one (`trent approvals approve <id>`). */
  readonly approvalId?: string;
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
  /** [S3] Compacts the conversation now (`/compact`); `force` compacts under the threshold too. */
  compact?(options?: { readonly force?: boolean }): Promise<SoloCompactionOutcome>;
  /** [S3] One note into the conversation, which the next turn reads (a `/rollback` in solo, A10). */
  note?(text: string): Promise<void>;
}
