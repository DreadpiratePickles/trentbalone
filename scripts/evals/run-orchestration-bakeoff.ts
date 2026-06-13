import * as fs from "fs/promises";
import * as path from "path";
import { runOrchestrationBakeoff } from "@/lib/orchestration-bakeoff";
import { runOrchestrationIntegrationSuite } from "@/lib/orchestration-eval-integration";

/**
 * Nightly bake-off entry point (guide Task 3.1). Runs flag permutations
 * against the mock-provider integration suite (no API keys needed), prints
 * the comparative report, and archives it under artifacts/evals/. Schedule
 * via cron/n8n: `npm run orc:bakeoff`.
 */
async function main() {
  const report = await runOrchestrationBakeoff({
    runSuite: () => runOrchestrationIntegrationSuite(),
  });
  const out = JSON.stringify(report, null, 2);
  process.stdout.write(`${out}\n`);

  const dir = path.resolve("artifacts", "evals");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `orchestration-bakeoff-${report.startedAt.slice(0, 10)}.json`);
  await fs.writeFile(file, `${out}\n`, "utf8");
  process.stdout.write(`Bake-off report written to ${file}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
