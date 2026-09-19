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
  type BaselineFixture,
  type ExecuteGateInput,
  type GateBaseline,
  type GateBlockReason,
  type GateCandidate,
  type GateFixtureVerdict,
  type GatePartition,
  type GateVerdict,
  type GatewayActualsOptions,
  type JudgeFn,
  type JudgeInput,
  type JudgeVerdict,
  type MeasuredBaseline,
  type RedrawReport,
} from "./gate.js";
export { JUDGE_ADVISORY_TAG, JUDGE_UNVERIFIED_TAG } from "./gate-score.js";
export { DEFAULT_REDRAW_TEMPERATURE, flippedFixtures } from "./gate-redraw.js";
export {
  DEFAULT_LOOP_LENGTH,
  REPETITIVE_LOOP_TAG,
  detectRepetitiveLoops,
  invocationKey,
  isRepetitiveLoopTag,
  type ToolCallLike,
  type ToolInvocation,
} from "./repetitive-loop.js";
export {
  DEFAULT_HOLDOUT_RATIO,
  buildOptimiseReflectionPrompt,
  holdoutRegressions,
  holdoutSuite,
  isHoldoutFixture,
  partitionMetrics,
  splitSuite,
  type PartitionMetrics,
  type SuiteSplit,
} from "./suite-split.js";
// [D0] improvement gates: the frozen surface, the partition, pass^k, the veto, calibration and
// the post-promotion re-run. Reflection stays off; these are what must exist before it is on.
export {
  FROZEN_REFUSAL_ACTOR,
  GATE_CODE_DIRS,
  JUDGE_PROMPT_FILES,
  createFrozenSurface,
  draftTargets,
  frozenRefusalMessage,
  frozenViolations,
  refuseFrozenDraft,
  type FrozenClass,
  type FrozenSurface,
  type FrozenSurfaceOptions,
  type FrozenTarget,
  type FrozenViolation,
} from "./frozen-surface.js";
export { DEFAULT_PASS_K, scoreUnderPassK, type PassKInput } from "./pass-k.js";
export { VETO_REFUSAL_ACTOR, isVetoed, vetoedHashes } from "./veto.js";
export {
  DEFAULT_JUDGE_MIN_TNR,
  DEFAULT_JUDGE_MIN_TPR,
  isJudgeAdvisory,
  judgeCalibration,
  type JudgeCalibration,
  type JudgeFloors,
} from "./calibration.js";
export { refuseBeforeScoring, type DraftDecision, type DraftGateContext } from "./draft-gates.js";
export { HOLDOUT_ROLLBACK_ACTOR, verifyPromotion, type VerifyPromotionInput, type VerifyPromotionReport } from "./post-promote.js";
export {
  distillCleanTrace,
  goldenId,
  goldenStepsHash,
  groupRowsByRun,
  rawTraceFromRows,
  type CleanGolden,
  type CleanStep,
  type DistillContext,
  type RawStep,
  type RawTrace,
} from "./clean-trace.js";
export {
  buildRationalePrompt,
  createFileExemplarStore,
  createGatewayRationale,
  createMemoryExemplarStore,
  parseRationaleReply,
  rationaliseGolden,
  type ExemplarStore,
  type RationaleFn,
  type RationaliseOptions,
  type RationaliseResult,
} from "./rationalise.js";
export { createGatewayJudge, parseJudgeReply, type GatewayJudgeOptions } from "./judge.js";
export {
  BUNDLED_MECHANICAL_OVERLAYS_DIR,
  applyMechanicalOverlay,
  loadMechanicalOverlay,
  mechanicalOverlayPath,
  type MechanicalOverlayJson,
} from "./mechanical-overlay.js";
export { contentHash, judgeAgreementFor, newId, recordLedger, setHash, type LedgerEntry } from "./ledger.js";
export { BASELINE_CACHE_SCHEMA, baselineCacheKey, createMemoryGateCache, judgeCacheKey, storeGateCache, type GateCache } from "./gate-cache.js";
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
  distillExemplars,
  promoteDraft,
  readLiveSkills,
  recoverDraft,
  rejectDraft,
  retireSkills,
  rollback,
  type DistillOnPromote,
  type DistillReport,
  type PromoteOptions,
  type RetirementOptions,
  type RetirementReport,
  type RollbackReport,
} from "./lifecycle.js";
export { DEFAULT_DISTILL_THRESHOLD, resolveSweepScope, type ResolveScopeInput, type SkippedSpecialist, type SweepScope } from "./scope.js";
export { defaultSeatPromptProvider, seatRoleFor, type SeatPromptProvider } from "./seat-prompt.js";
export {
  MAX_PROPOSAL_GROWTH,
  PROPOSAL_TOO_LONG,
  SUITE_SATURATED,
  isProposalTooLong,
  runGepaPass,
  type GepaPassInput,
  type GepaPassResult,
  type ReflectFn,
} from "./gepa-pass.js";
export { cleanTraces, runImprovementSweep, toTraceRecord, type AgentSweepReport, type SweepDeps, type SweepReport } from "./sweep.js";
export { ORG_TIER_AGENT, promoteOrgSkill, type PromoteOrgSkillInput, type PromoteOrgSkillResult } from "./org-tier.js";
export { improveStatus, judgeAgreementOf, type FrontierBest, type ImproveStatus, type JudgeAgreement, type QuarantineEntry } from "./status.js";
