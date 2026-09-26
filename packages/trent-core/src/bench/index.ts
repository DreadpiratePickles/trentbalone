/**
 * [C16] `trent bench`: a head-to-head of Trent solo, Hermes Agent and the Trent fleet on the same model, the
 * same tools and the same tasks, graded on the end state of fake business and social servers, never by a
 * model (council verdict C16, `02_plan/output/hermes-council-verdict-2026-09-26.md`; `docs/bench.md`).
 */
export { runBench, runBenchReport, type AttemptRunner, type BenchHarness, type BenchPlan } from "./bench-run.js";
export { costOfRows, costOfTokens, MICRO_PER_CENT, NO_COST, type AttemptCost } from "./cost.js";
export { carriesModelOutput, createFirstOutput, timedGateway, type FirstOutput } from "./first-output.js";
export { BENCH_SURFACE, createRunnerBenchSession, type BenchModeRunner, type RunnerSessionInput } from "./fleet-runner.js";
export { gradeTask } from "./grade.js";
export { HERMES_TOOLSET, hermesArgs, hermesConfig, hermesVersion, runHermesAttempt, type HermesAttemptEnv, type HermesInvocation, type HermesVersion } from "./hermes-runner.js";
export { createHermesStreamReader, type HermesResult, type HermesStreamSummary } from "./hermes-stream.js";
export { hostBenchTools, type BenchToolHost } from "./mcp-host.js";
export { createOperator, heldCallOf, STEP_GATE, withOperator, type BenchOperator } from "./operator.js";
export { buildReport, centsText, COST_TARGET_MICRO_CENTS, COST_TARGET_MODEL, medianMs, renderReport, type BuiltReport, type HarnessSummary, type Rate, type ReportMeta, type TargetVerdict } from "./report.js";
export { fingerprint, selectTasks, SMB_20, suiteById, SUITES } from "./suite.js";
export { BENCH_TOOL_CONFIG, BENCH_TOOLSETS, benchToolDeps, buildBenchTools, type BenchToolInput, type BenchTools } from "./tools.js";
export { createSoloBenchSession, runTrentAttempt, type AttemptEnv, type SoloBenchSessionInput, type TrentSession } from "./trent-runner.js";
export { HARNESS_IDS, TASK_CLASSES, type BenchSuite, type BenchTask, type HarnessId, type TaskClass, type TaskGrade, type TaskRun, type WorldSeed } from "./types.js";
export { BLUESKY_MENTION_URI, startBenchWorld, type BenchWorld } from "./world.js";
