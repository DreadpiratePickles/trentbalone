/**
 * Local mirrors of the orchestrator's public shapes.
 *
 * These are DELIBERATELY redeclared rather than re-exported from `@/lib/orchestrator`. A type-only
 * re-export still makes `tsc` load `apps/web/lib/orchestrator.ts` and its transitive graph (Prisma
 * client types, Next request types, the whole runtime), which turns a package type-check into an
 * application type-check. The wrapper casts the structurally-identical runtime values across the
 * boundary in `index.ts`, in exactly one place.
 *
 * Source of truth, kept in sync by hand:
 *   - `apps/web/lib/orchestrator-events.ts:12-41`  (OrcEventKind, OrcEvent)
 *   - `apps/web/lib/orchestrator.ts:130-154`       (OrchestrationRun)
 *   - `apps/web/lib/orchestrator-runtime.ts:216-345` (OrchestrationStep, StepRecord)
 */

import type { ModelGateway } from "../model-gateway/types.js";

/** The 20 event kinds carried on the in-process bus (`__trentOrcBus`). */
export type OrcEventKind =
  | "run_preflight"
  | "run_start"
  | "plan_start"
  | "plan_end"
  | "step_pending"
  | "step_start"
  | "step_output"
  | "step_critic"
  | "step_note"
  | "step_end"
  | "step_blocked"
  | "step_awaiting_approval"
  | "step_approved"
  | "consolidate_start"
  | "consolidate_end"
  | "run_awaiting_approval"
  | "run_done"
  | "run_failed"
  | "run_cancelled"
  | "heartbeat";

export type OrchestrationRunStatus =
  | "planning"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "awaiting_approval";

export type OrchestrationRiskLevel = "low" | "medium" | "high";

export type OrchestrationTrigger = "manual" | "scheduled" | "delegated" | "heartbeat";

/** One planned unit of work plus its execution record. `agentRole` is one of the 164 catalog seats. */
export interface OrchestrationStepSnapshot {
  readonly id: string;
  readonly title: string;
  readonly rationale: string;
  readonly agentRole: string;
  readonly dependsOn: readonly string[];
  readonly expectedOutput: string;
  readonly riskLevel: OrchestrationRiskLevel;
  readonly needsApproval: boolean;
  readonly status: OrchestrationStepStatus;
  readonly output?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly model?: string;
  readonly tokens?: number;
  readonly costCents?: number;
  readonly approvalId?: string;
}

export interface OrchestrationPlanSnapshot {
  readonly objective: string;
  readonly reasoning: string;
  readonly steps: readonly OrchestrationStepSnapshot[];
  readonly successCriteria: readonly string[];
  readonly blockers: readonly string[];
}

export interface OrchestrationRunSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly objective: string;
  readonly status: OrchestrationRunStatus;
  readonly plan?: OrchestrationPlanSnapshot;
  readonly steps: readonly OrchestrationStepSnapshot[];
  readonly summary?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly trigger: OrchestrationTrigger;
  readonly cycleId?: string;
  readonly fullTeam?: boolean;
  readonly replanCount?: number;
}

/** A single frame from the run's event stream. */
export interface OrcEvent {
  readonly kind: OrcEventKind;
  readonly runId: string;
  readonly at: string;
  readonly step?: Partial<OrchestrationStepSnapshot>;
  readonly run?: Partial<OrchestrationRunSnapshot>;
  readonly detail?: string;
}

/**
 * The top function type. Used for the injected model ports so the public API neither says `any` nor
 * drags `apps/web`'s `CallJsonOptions` / `executeSeatModel` signatures into this package's graph.
 * Parameters are contravariant, so `never[]` accepts any concrete function.
 */
export type InjectedModelPort = (...args: never[]) => unknown;

/** Receives every event the run emits, whether or not the caller iterates the handle. */
export type TraceSink = (event: OrcEvent) => void;

/**
 * The provider and model the user configured (`config.provider` / `config.model`). The wrapper maps
 * these into the env the orchestrator's model resolver reads — `MODEL_PREFERRED_PROVIDER` and the
 * per-provider `<PROVIDER>_MODEL_FAST/DEFAULT/STRONG` — BEFORE any `apps/web` module loads, because
 * `ai-client.ts` freezes its registry at import time. Without this mapping a Google user's seats
 * are routed to the retired `gemini-2.0-flash` / `gemini-2.5-pro` defaults and every call 404s
 * (live proof, finding F2).
 */
export interface OrchestratorModelConfig {
  readonly provider: string;
  readonly model: string;
  /**
   * `model_overrides` from config. Travels to the gateway through the env bridge that
   * `applyModelEnv` writes, because the orchestrator builds its gateway with no arguments — the
   * same route the `privacy` block takes.
   */
  readonly overrides?: Readonly<Record<string, { context_window?: number; input_cents_per_million?: number; output_cents_per_million?: number }>>;
}

/** One chat-completion request as the seat executor issues it. Mirrors `ChatCompletionInput`. */
export interface SeatChatRequest {
  readonly model: string;
  readonly temperature: number;
  readonly response_format: { readonly type: "json_object" };
  readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>;
}

/** The provider's reply. Mirrors `ChatCompletionOutput`. */
export interface SeatChatResponse {
  readonly choices: ReadonlyArray<{ readonly message: { readonly content: string | null } }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

/**
 * The seat-level provider port. Unlike `executeSeatModelFn` it replaces only the HTTP call, so the
 * real route, tier, model-name resolution, JSON parsing and cost estimate still run. A throw is a
 * provider failure and is what makes the wrapper fail the run (D1).
 */
export type SeatChatCompletionFn = (request: SeatChatRequest) => Promise<SeatChatResponse>;

/**
 * The words that make the deterministic FALLBACK planner (used whenever no planner model answers)
 * add an approval gate to its plan. Source: `apps/web/lib/orchestrator-runtime.ts`,
 * `generateOrchestrationPlan` — `/\b(publish|send|merge|deploy|spend|charge|refund|withdraw|delete)\b/i`
 * tested against the objective. That file is read-only, so the wrapper documents the trigger here
 * and explains the gate on the `*_awaiting_approval` events it emits (D4).
 */
export const FALLBACK_PLANNER_APPROVAL_TRIGGERS: readonly string[] = [
  "publish",
  "send",
  "merge",
  "deploy",
  "spend",
  "charge",
  "refund",
  "withdraw",
  "delete",
];

/** The `plan.reasoning` the fallback planner stamps on its plans. */
export const FALLBACK_PLAN_REASONING = "LLM unavailable — using deterministic fallback plan.";

/**
 * The literal `consolidateRun` returns when its `callText` fails (`orchestrator-runtime.ts`,
 * `callTextWithFallback`). `callText` has no injection seam and reads `OPENAI_API_KEY` directly,
 * so on any other provider this literal IS the summary; the wrapper replaces it (see
 * `provider-ports.ts`).
 */
export const FALLBACK_RUN_SUMMARY = "Run completed — see step outputs.";

export interface OrchestratorDeps {
  /**
   * SQLite connection string for durable mode. Defaults to the in-memory store, which is what makes
   * an orchestration runnable with no Postgres and no Redis.
   */
  readonly databaseUrl?: string;
  /** The configured provider and model; see {@link OrchestratorModelConfig}. */
  readonly model?: OrchestratorModelConfig;
  /**
   * The model gateway the planner, critic and consolidator go through. Omit to build the real one
   * (`createModelGateway()`), which routes to the configured provider and model; tests inject a
   * recording fake.
   */
  readonly gateway?: ModelGateway;
  /**
   * Planner/critic JSON completion port. Omit to use the gateway-backed port
   * (`createCompletionPort(gateway)`), which is the default for every surface, not only tests.
   */
  readonly createCompletion?: InjectedModelPort;
  /** Seat execution port. Omit to use the real gateway (wrapped by the seat guard). */
  readonly executeSeatModelFn?: InjectedModelPort;
  /** Seat-level provider port; see {@link SeatChatCompletionFn}. Ignored when `executeSeatModelFn` is set. */
  readonly createChatCompletion?: SeatChatCompletionFn;
  /** Observer for every event on every run this orchestrator starts. */
  readonly traceSink?: TraceSink;
  /** Default bound on drain-loop iterations per run. See `DEFAULT_MAX_JOBS`. */
  readonly maxJobs?: number;
}

/**
 * One earlier message of the surface's conversation. Threaded ALONGSIDE the objective, never
 * folded into it: the planner keeps receiving the raw new line, and the fleet-memory hook renders
 * the transcript after its frozen prelude so the cacheable prefix stays byte-stable.
 */
export interface ConversationMessage {
  /**
   * `system` carries exactly one thing: a session's compaction summary, which stands in for turns
   * the transcript no longer holds (`sessions/compaction.ts`). Nothing else may take that role —
   * a surface must not be able to put words in the system's mouth by calling them a turn.
   */
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

export interface OrchestratorRunOptions {
  readonly companyId: string;
  readonly objective: string;
  /** The turns before this one, oldest first. Bounded by the caller, not here. */
  readonly history?: readonly ConversationMessage[];
  readonly trigger?: OrchestrationTrigger;
  /**
   * [G3] Which surface asked for this run — `repl`, `run`, `gateway`, `cron`, `heartbeat`, `a2a`,
   * `acp`. It is not routing: `openRunScope` tags the run's spend meter with it, so the day's
   * ledger says who spent. A run that names none is metered as `unknown` rather than guessed at.
   */
  readonly surface?: string;
  readonly fullTeam?: boolean;
  /** Hard upper bound on drain iterations. Coding rule 9: every loop is bounded. */
  readonly maxJobs?: number;
  /** Aborting stops the drain loop cooperatively; it never terminates the process. */
  readonly signal?: AbortSignal;
}

/**
 * A live run. Iterate it for events as they happen; `result()` resolves once the drain loop has
 * stopped — normally, or because of `cancel()`, an abort, or the `maxJobs` bound.
 */
export type OrchestratorRunHandle = AsyncIterable<OrcEvent> & {
  /**
   * The run id. Throws until the run has been created, because `launchOrchestration` mints the id
   * asynchronously; `await handle.started` first if you need it immediately.
   */
  readonly runId: string;
  /** Resolves with the run id as soon as the run row exists and the event subscription is live. */
  readonly started: Promise<string>;
  result(): Promise<OrchestrationRunSnapshot>;
  cancel(): Promise<boolean>;
};

/** The company a surface runs against. Looked up by slug so a restart finds the same one. */
export interface EnsureCompanyInput {
  readonly name: string;
  /** Defaults to a slug of `name`. */
  readonly slug?: string;
  readonly vision?: string;
}

/** What `resume` takes: the run is known, so no company, objective or trigger. */
export type OrchestratorResumeOptions = Pick<OrchestratorRunOptions, "surface" | "maxJobs" | "signal">;

export interface Orchestrator {
  run(options: OrchestratorRunOptions): OrchestratorRunHandle;
  /**
   * D2: picks an existing run back up in THIS process — one a killed `trent run`, cron tick or
   * heartbeat left `running` — re-enqueues what is ready and drains it to a verdict. A finished
   * run resolves with its snapshot untouched; an unknown id rejects `started`. A side-effecting
   * tool call the dead process recorded is answered from the idempotency store, not repeated.
   * Optional only so the older fakes stay valid; `createOrchestrator` always provides it.
   */
  resume?(runId: string, options?: OrchestratorResumeOptions): OrchestratorRunHandle;
  /**
   * Returns the id of the company with this slug, creating it when absent. `launchOrchestration`
   * throws "Company not found" for an unknown id, and nothing else in the CLI path creates one.
   */
  ensureCompany(input: EnsureCompanyInput): Promise<string>;
  snapshot(runId: string): Promise<OrchestrationRunSnapshot | undefined>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
  /**
   * Answers a step parked on `ask_human` (`../tools/human`): the text becomes the tool's result
   * on the replay, then the step is released exactly as `approve` releases it. Optional only so
   * the older fakes stay valid; `createOrchestrator` always provides it.
   */
  answer?(runId: string, stepId: string, text: string): Promise<boolean>;
}
