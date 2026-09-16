/**
 * Bun entrypoint for the store scenarios. Run as:
 *   bun packages/trent-core/src/store/scenario-runner.ts <scenario> <sqlite-file>
 * Prints one JSON object on stdout. Exits 1 with the error on stderr on failure.
 *
 * This exists because bun:sqlite has no Node equivalent: the vitest suite spawns this so the
 * production code path is exercised by the real runtime instead of a stand-in.
 */

import {
  runAuditScenario,
  runConcurrencyScenario,
  runDurabilityScenario,
  runTransactionScenario,
  seedAuditChain,
} from "./scenarios.js";

const SCENARIOS: Record<string, (url: string) => Promise<unknown>> = {
  durability: runDurabilityScenario,
  concurrency: runConcurrencyScenario,
  transaction: runTransactionScenario,
  audit: runAuditScenario,
  /** Seeds the chain and stops, so a CLI test can export it from a temp profile. */
  "audit-seed": seedAuditChain,
};

async function main(): Promise<void> {
  const [name, file] = process.argv.slice(2);
  const scenario = name === undefined ? undefined : SCENARIOS[name];
  if (scenario === undefined || file === undefined) {
    throw new Error(`usage: scenario-runner <${Object.keys(SCENARIOS).join("|")}> <sqlite-file>`);
  }
  const result = await scenario(`file:${file}`);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
