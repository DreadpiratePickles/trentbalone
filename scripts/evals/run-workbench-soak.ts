import * as fs from "fs/promises";
import * as path from "path";
import { buildWorkbenchGoldenObjectives } from "@/lib/workbench-eval-suite";
import { runMockWorkbenchSoak } from "@/lib/workbench-soak-mock";
import { flakiestFailure } from "@/lib/workbench-soak";

/**
 * Build-reliability soak (PARITY-PLAN P5). Runs one golden objective N times
 * headless through the mock workbench provider and reports the pass rate,
 * gating on the ≥18/20 (0.9) bar. Archives the report under artifacts/evals/.
 *
 *   npm run workbench:soak -- [--objective wb_countdown] [--n 20] [--threshold 0.9] [--broken-every 0]
 *
 * The real E2B/Daytona soak is the credentialed follow-up: same instrument,
 * swap runMockWorkbenchSoak's executor for a live provider.
 */
function parseArgs(argv: string[]) {
  let objectiveId = "wb_countdown";
  let n = 20;
  let threshold = 0.9;
  let brokenEvery = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--objective") objectiveId = argv[++i] ?? objectiveId;
    else if (arg === "--n") n = Number(argv[++i]);
    else if (arg === "--threshold") threshold = Number(argv[++i]);
    else if (arg === "--broken-every") brokenEvery = Number(argv[++i]);
  }
  return { objectiveId, n, threshold, brokenEvery };
}

async function main() {
  const { objectiveId, n, threshold, brokenEvery } = parseArgs(process.argv.slice(2));
  const objective = buildWorkbenchGoldenObjectives().find((item) => item.id === objectiveId);
  if (!objective) {
    console.error(`Unknown objective "${objectiveId}".`);
    process.exitCode = 1;
    return;
  }

  const report = await runMockWorkbenchSoak({ objective, iterations: n, threshold, brokenEvery });
  const out = JSON.stringify(report, null, 2);
  process.stdout.write(`${out}\n`);
  process.stdout.write(
    `\n${report.passed}/${report.iterations} passed (${report.passRate}) — ${report.meetsThreshold ? "MEETS" : "BELOW"} ${threshold} bar.` +
      (report.failureHistogram.length ? ` Flakiest failure: ${flakiestFailure(report)}.` : "") +
      "\n",
  );

  const dir = path.resolve("artifacts", "evals");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `workbench-soak-${objectiveId}-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(file, `${out}\n`, "utf8");
  process.stdout.write(`Soak report written to ${file}\n`);
  process.exitCode = report.meetsThreshold ? 0 : 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
