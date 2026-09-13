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

export interface OrchestratorDeps {
  /**
   * SQLite connection string for durable mode. Defaults to the in-memory store, which is what makes
   * an orchestration runnable with no Postgres and no Redis.
   */
  readonly databaseUrl?: string;
  /** The configured provider and model; see {@link OrchestratorModelConfig}. */
  readonly model?: OrchestratorModelConfig;
  /** Planner/critic JSON completion port. Omit to use the real gateway. */
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

export interface OrchestratorRunOptions {
  readonly companyId: string;
  readonly objective: string;
  readonly trigger?: OrchestrationTrigger;
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

export interface Orchestrator {
  run(options: OrchestratorRunOptions): OrchestratorRunHandle;
  /**
   * Returns the id of the company with this slug, creating it when absent. `launchOrchestration`
   * throws "Company not found" for an unknown id, and nothing else in the CLI path creates one.
   */
  ensureCompany(input: EnsureCompanyInput): Promise<string>;
  snapshot(runId: string): Promise<OrchestrationRunSnapshot | undefined>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
}
