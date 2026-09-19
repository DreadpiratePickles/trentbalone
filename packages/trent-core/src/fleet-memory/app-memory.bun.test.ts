/**
 * [C1] Acceptance for the app's company memory, under the runtime the shipped binary uses.
 *
 * Why a Bun child and not a plain vitest suite: `apps/web/lib/store.ts` chooses its store once, at
 * module evaluation, from `DATABASE_URL`. The two things worth proving — that a fact seat A wrote
 * in run 1 reaches seat B in run 2, and that the standalone DURABLE profile cannot reach the app
 * store at all — are two different values of that variable, so they are two processes. Bun is the
 * runtime because it is the one the compiled CLI runs under and the only one whose profile is
 * durable (`apps/cli/src/runtime/headless.ts:110-119`).
 *
 * Under Node with no bun on the machine the whole suite skips with the reason printed, rather than
 * passing on a runtime that cannot answer the question.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PropagationResult, SqliteProfileResult } from "./app-memory-runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "app-memory-runner.ts");

function findBun(): string | null {
  const fromEnv = process.env.TRENT_BUN_BIN;
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) return fromEnv;
  try {
    const onPath = execSync("command -v bun", { encoding: "utf8" }).trim();
    if (onPath !== "") return onPath;
  } catch {
    // The installer appends its PATH line to the shell rc, which vitest never sources.
  }
  const standard = path.join(homedir(), ".bun", "bin", "bun");
  return existsSync(standard) ? standard : null;
}

const bun = findBun();
/** Named into the suite titles so a skipped run says WHY on the reporter's own line. */
const why =
  bun === null
    ? " [SKIPPED: bun is not on this machine, and the app memory cannot be exercised under the runtime the CLI ships with]"
    : "";

function runScenario<T>(scenario: string): T {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "trent-c1-db-")), "trent.db");
  const stdout = execFileSync(bun as string, [runner, scenario, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TRENT_QUEUE_FALLBACK: "disabled" },
  });
  return JSON.parse(stdout) as T;
}

describe.skipIf(bun === null)(`company memory across runs, under Bun${why}`, () => {
  let result: PropagationResult;
  beforeAll(() => {
    result = runScenario<PropagationResult>("propagation");
  });

  it("accepted the seat's append and mirrored it into the app's episodic tier", () => {
    expect(result.episodeWrite.status).toBe("completed");
    expect(result.factWrites.map((write) => write.reason)).toEqual([null, null]);
    expect(result.factWrites[0]?.written).toBe(1);
    expect(result.factWrites[1]?.written).toBe(1);
  });

  it("kept the writing seat's own prompt free of what it had not written yet", () => {
    expect(result.run1Growth).not.toContain("doubled signup completion");
  });

  it("hands seat B in run 2 what seat A learned in run 1", () => {
    expect(result.run2Sales).toContain("doubled signup completion");
  });

  it("recalls the current fact and not the one it superseded", () => {
    expect(result.run2Sales).toContain("activation stands at 55 percent");
    expect(result.run2Sales).not.toContain("activation stands at 40 percent");
  });

  it("names the app surface each recalled line came from", () => {
    expect(result.run2Sales).toContain("tiers |");
    expect(result.appEntrySources).toContain("tiers");
  });
});

describe.skipIf(bun === null)(`the standalone durable profile, under Bun${why}`, () => {
  it("degrades to no app memory and says why, instead of failing the seat", () => {
    const result = runScenario<SqliteProfileResult>("sqlite");
    expect(result.entries).toBe(0);
    // `apps/web/lib/db.ts` is a postgresql client; `<profile>/trent.db` is a SQLite file.
    expect(result.writeReason).toContain("postgresql");
  });
});

