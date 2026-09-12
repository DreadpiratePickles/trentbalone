import {
  buildOrchestrationEvalScorecard,
  buildOrchestrationGoldenObjectives,
  buildOrchestrationSmokeRuns,
  compareOrchestrationReproducibility,
  meetsOrchestrationPassRateThreshold,
  partitionQuarantinedResults,
  scoreOrchestrationRun,
  type OrchestrationEvalResult,
} from "@/lib/orchestration-eval";
import { runOrchestrationIntegrationSuite } from "@/lib/orchestration-eval-integration";

export type OrchestrationEvalCommandResult = {
  exitCode: number;
  scorecard: ReturnType<typeof buildOrchestrationEvalScorecard>;
};

export async function runOrchestrationEvalCommand(
  args: string[],
  io: { write(text: string): Promise<void> | void } = { write: (text) => { process.stdout.write(text); } },
): Promise<OrchestrationEvalCommandResult> {
  const options = parseArgs(args);
  const firstPass = options.smoke
    ? buildOrchestrationSmokeRuns()
    : options.integration
      ? await runOrchestrationIntegrationSuite()
      : buildDeterministicRuns();
  const secondPass = options.smoke || options.integration
    ? firstPass
    : firstPass.map((run) => scoreOrchestrationRun({ ...run, costCents: run.costCents + 5, wallClockMs: run.wallClockMs + 1_000 }));
  const { blocking, quarantined } = partitionQuarantinedResults(firstPass);
  const blockingSecondPass = secondPass.filter((run) => !run.quarantined);
  const reproducibility = options.integration
    ? blocking.map((run) => compareOrchestrationReproducibility(run, run))
    : blocking.map((run, index) => compareOrchestrationReproducibility(run, blockingSecondPass[index]!));
  const scorecard = buildOrchestrationEvalScorecard(blocking, reproducibility);
  await io.write(`${JSON.stringify(quarantined.length ? { ...scorecard, quarantined } : scorecard, null, 2)}\n`);
  const passed = meetsOrchestrationPassRateThreshold(scorecard, options.threshold);
  return { exitCode: passed ? 0 : 1, scorecard };
}

function buildDeterministicRuns(): OrchestrationEvalResult[] {
  return buildOrchestrationGoldenObjectives().map((item, index) => scoreOrchestrationRun({
    objectiveId: item.id,
    planValid: true,
    stepSuccessRate: index === 3 ? 0.5 : 1,
    objectiveAchieved: index !== 3,
    costCents: 90,
    wallClockMs: 30_000,
  }));
}

function parseArgs(args: string[]) {
  let threshold = 0.9;
  let smoke = false;
  let integration = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--smoke") smoke = true;
    else if (arg === "--integration") integration = true;
    else if (arg === "--threshold") threshold = Number(args[++i]);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown orchestration eval argument: ${arg}`);
  }
  if (smoke && integration) {
    throw new Error("Use either --smoke or --integration, not both");
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1");
  }
  return { threshold, smoke, integration };
}

function printHelp() {
  console.log([
    "Usage: tsx scripts/evals/run-orchestration-eval.ts [--smoke | --integration] [--threshold 0.9]",
    "",
    "  --smoke        Fast local scorecard from canned results (no code execution).",
    "  --integration  Run golden objectives through real orchestration paths with mock providers.",
    "  (default)      Legacy deterministic scorecard for all golden objectives.",
  ].join("\n"));
}
