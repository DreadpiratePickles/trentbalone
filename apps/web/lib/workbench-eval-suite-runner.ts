import {
  buildWorkbenchEvalScorecard,
  buildWorkbenchGoldenObjectives,
  buildWorkbenchSmokeResults,
  meetsWorkbenchPassRateThreshold,
  scoreWorkbenchObjective,
  type WorkbenchEvalResult,
} from "@/lib/workbench-eval-suite";
import { runWorkbenchIntegrationSuite } from "@/lib/workbench-eval-integration";

export type WorkbenchEvalSuiteCommandResult = {
  exitCode: number;
  scorecard: ReturnType<typeof buildWorkbenchEvalScorecard>;
};

export async function runWorkbenchEvalSuiteCommand(
  args: string[],
  io: { write(text: string): Promise<void> | void } = { write: (text) => { process.stdout.write(text); } },
): Promise<WorkbenchEvalSuiteCommandResult> {
  const options = parseArgs(args);
  const results = options.smoke
    ? buildWorkbenchSmokeResults()
    : options.integration
      ? await runWorkbenchIntegrationSuite()
      : await runDeterministicSuite();
  const scorecard = buildWorkbenchEvalScorecard(results);
  await io.write(`${JSON.stringify(scorecard, null, 2)}\n`);
  const passed = meetsWorkbenchPassRateThreshold(scorecard, options.threshold);
  return { exitCode: passed ? 0 : 1, scorecard };
}

async function runDeterministicSuite(): Promise<WorkbenchEvalResult[]> {
  return buildWorkbenchGoldenObjectives().map((item, index) => scoreWorkbenchObjective({
    objectiveId: item.id,
    buildClean: true,
    interactionsPass: index !== 7,
    criticPass: true,
    screenshotNonBlank: true,
    attempts: 1,
    costCents: 40,
    wallClockMs: 70_000,
  }));
}

function parseArgs(args: string[]) {
  let threshold = 0.8;
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
    } else throw new Error(`Unknown workbench eval argument: ${arg}`);
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
    "Usage: tsx scripts/evals/run-live-cloud-workbench.ts --suite [--smoke | --integration] [--threshold 0.8]",
    "",
    "  --smoke        Fast local scorecard from canned results (no code execution).",
    "  --integration  Run golden objectives through runWorkbenchAgent with mock providers.",
    "  (default)      Legacy deterministic scorecard for all golden objectives.",
  ].join("\n"));
}

export { parseArgs as parseWorkbenchEvalSuiteArgs };
