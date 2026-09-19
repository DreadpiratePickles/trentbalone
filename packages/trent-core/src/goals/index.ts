/**
 * D4 — goals with deterministic shell quality gates, and verify_on_stop (docs/goals.md).
 *
 * Two rules, one module. A goal's gates are shell commands that must exit 0 before the model judge
 * is consulted, and a red gate's output tail becomes the next run's prompt. `verify_on_stop`
 * refuses a final answer on any turn that edited code without fresh evidence that something passed
 * afterwards. Both are evidence before judgment, which is principle 6 of the Hermes inventory and
 * consensus principles 8 and 9 of the SOTA survey.
 */

export { GoalsConfigSchema, goalsConfig, type GoalsConfig } from "./config-schema.js";
export {
  VERIFIABLE_ADAPTERS,
  VerificationLedger,
  actionCommand,
  commandArgv,
  exitCodeOf,
  matchesVerification,
  verificationKey,
  watchVerification,
  type ObservableAdapter,
  type ObservedRecord,
  type VerificationEvent,
} from "./evidence.js";
export {
  boundedTail,
  firstRed,
  gateCommandLine,
  gateReport,
  parseGateFlag,
  runGate,
  runGates,
  type GateBackend,
} from "./gates.js";
export {
  continuationFor,
  finishGoalRun,
  markContinued,
  type FinishGoalRunInput,
  type GoalJudge,
  type GoalJudgement,
  type RunOutcome,
  type RunVerdict,
} from "./run-goal.js";
export {
  GoalSession,
  activeGoalSession,
  closeGoalSession,
  openGoalSession,
  type GoalSessionOptions,
} from "./session.js";
export { GoalStore, newGoalId, type CreateGoalInput } from "./store.js";
export {
  DEFAULT_MAX_CONTINUATIONS,
  DEFAULT_VERIFY_COMMANDS,
  GATE_TAIL_MAX_CHARS,
  GOALS_DIR_MODE,
  GOALS_FILE_MODE,
  GoalError,
  type GateResult,
  type GoalContinuation,
  type GoalGate,
  type GoalMessage,
  type GoalRecord,
  type GoalRunRecord,
  type GoalStatus,
} from "./types.js";
export {
  turnWrites,
  verifyOnStop,
  type LedgerRow,
  type TurnWrite,
  type UnverifiedRefusal,
  type VerifyOnStopInput,
} from "./verify.js";
