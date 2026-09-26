import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CI workflow must switch the live suites on with the SAME variable vitest reads, or the live job
 * runs zero live tests and looks green. Found by the 2026-09-26 council: ci.yml set `TRENT_LIVE_TESTS`
 * while vitest.config.ts reads `TRENT_TEST_LIVE`, so the 26 live files never ran in CI.
 */
const ROOT = resolve(__dirname, "../../../../..");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const VITEST_CONFIG = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
const LIVE_SWITCH = "TRENT_TEST_LIVE";

function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name} exists`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the CI live job and vitest agree on the live-test switch", () => {
  it("vitest.config.ts gates the live suites on the one variable", () => {
    expect(VITEST_CONFIG).toContain(`process.env.${LIVE_SWITCH} === "1"`);
  });

  it("the live-provider-tests job sets that variable, and only that name", () => {
    const job = jobBlock("live-provider-tests");
    expect(job).toMatch(new RegExp(`^\\s+${LIVE_SWITCH}: "1"$`, "m"));
    expect(job).not.toContain("TRENT_LIVE_TESTS");
  });

  it("no source file reads a second name for the switch", () => {
    const readers = [
      ...sourceFiles(join(ROOT, "packages/trent-core/src")),
      ...sourceFiles(join(ROOT, "apps/cli/src")),
      ...sourceFiles(join(ROOT, "scripts")),
    ]
      .filter((file) => !file.endsWith("ci-workflow-truth.test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("TRENT_LIVE_TESTS"));
    expect(readers.map((file) => file.slice(ROOT.length + 1))).toEqual([]);
  });
});
