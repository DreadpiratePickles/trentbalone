/**
 * `@trent/core/improve` — the self-improvement loop, connected.
 *
 * trace store -> eval gate (executing) -> skill foundry -> GEPA on a per-agent Pareto frontier ->
 * skill health + cascade -> golden capture from failures, plus the three things adopted from
 * Hermes: retirement, a hash ledger, and rollback — all behind the protected-prompt rule.
 * Built entirely off the orchestrator wrapper's event bus and the durable SQLite store;
 * `apps/web` is never touched.
 */

export { InMemoryImproveStore } from "./memory-store.js";
export { SqliteImproveStore, type RawSql } from "./sqlite-store.js";
export {
  CORE_SEATS,
  SEAT_ROLES,
  createTraceWriter,
  deriveTaskType,
  evalScoreFromCritique,
  isTraceableAgent,
  type BusHook,
  type TraceWriterOptions,
} from "./trace-writer.js";
export {
  createGoldenCapture,
  sanitizeGoldenText,
  type CapturedGolden,
  type GoldenCapture,
  type GoldenCaptureFn,
  type GoldenCaptureOptions,
} from "./golden-capture.js";
export { createImproveHook, type ImproveHook, type ImproveHookOptions } from "./hook.js";
export { SKILL_PRELUDE_MARKER, createSkillInjector, type SeatCallLike, type SkillInjector, type SkillInjectorOptions } from "./skill-injection.js";
export * from "./suites.js";
export {
  composeSystemPrompt,
  createGatewayActuals,
  executeGate,
  extractToolCalls,
  hasNewFailureCluster,
  measureBaseline,
  type ActualsInput,
  type ActualsOutput,
  type ActualsRunner,
  type ExecuteGateInput,
  type GateBaseline,
  type GateBlockReason,
  type GateCandidate,
  type GateFixtureVerdict,
  type GateVerdict,
  type GatewayActualsOptions,
  type JudgeFn,
  type JudgeInput,
  type JudgeVerdict,
  type MeasuredBaseline,
} from "./gate.js";
export { contentHash, newId, recordLedger, setHash, type LedgerEntry } from "./ledger.js";
export { baselineCacheKey, createMemoryGateCache, judgeCacheKey, storeGateCache, type GateCache } from "./gate-cache.js";
export { BudgetExhaustedError, SweepMeter, emptyPhases, isBudgetExhausted, type PhaseReport, type PhaseTally, type SweepPhase } from "./meter.js";
export {
  ProtectedPromptError,
  SEAT_PROMPT_TASK_TYPE,
  readSeatPrompt,
  stagePromptProposal,
  writeSeatPrompt,
  type StagePromptInput,
  type WriteSeatPromptInput,
} from "./protected-prompt.js";
export {
  promoteDraft,
  readLiveSkills,
  recoverDraft,
  rejectDraft,
  retireSkills,
  rollback,
  type PromoteOptions,
  type RetirementOptions,
  type RetirementReport,
  type RollbackReport,
} from "./lifecycle.js";
export { DEFAULT_DISTILL_THRESHOLD, resolveSweepScope, type ResolveScopeInput, type SkippedSpecialist, type SweepScope } from "./scope.js";
export { defaultSeatPromptProvider, seatRoleFor, type SeatPromptProvider } from "./seat-prompt.js";
export { runGepaPass, type GepaPassInput, type GepaPassResult, type ReflectFn } from "./gepa-pass.js";
export { runImprovementSweep, toTraceRecord, type AgentSweepReport, type SweepDeps, type SweepReport } from "./sweep.js";
export { ORG_TIER_AGENT, promoteOrgSkill, type PromoteOrgSkillInput, type PromoteOrgSkillResult } from "./org-tier.js";
export { improveStatus, type FrontierBest, type ImproveStatus, type QuarantineEntry } from "./status.js";
