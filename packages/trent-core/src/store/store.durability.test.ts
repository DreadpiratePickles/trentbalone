import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConcurrencyResult,
  DurabilityResult,
  TransactionResult,
} from "./scenarios.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "scenario-runner.ts");

/**
 * These tests drive the REAL production path — the vendored bun:sqlite adapter — by running
 * it under the real Bun binary as a child process. bun:sqlite has no Node equivalent, and
 * the Node alternative (@prisma/adapter-better-sqlite3) will not build here: better-sqlite3
 * fails node-gyp compilation against Node 26. Substituting a different driver would test a
 * driver we do not ship, so we test the one we do.
 */
function findBun(): string {
  const fromEnv = process.env.TRENT_BUN_BIN;
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) {
    return fromEnv;
  }
  try {
    const onPath = execSync("command -v bun", { encoding: "utf8" }).trim();
    if (onPath !== "") {
      return onPath;
    }
  } catch {
    // fall through to the explicit failure below
  }
  throw new Error(
    "bun not found. The store adapter is bun:sqlite and cannot be exercised without it. " +
      "Set TRENT_BUN_BIN to the bun binary, or put bun on PATH.",
  );
}

function runScenario<T>(bun: string, scenario: string): T {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "trent-store-")), "trent.db");
  const stdout = execFileSync(bun, [runner, scenario, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout) as T;
}

describe("prisma-on-sqlite store, under Bun", () => {
  let bun = "";
  beforeAll(() => {
    bun = findBun();
  });

  describe("durability across a restart", () => {
    let result: DurabilityResult;
    beforeAll(() => {
      result = runScenario<DurabilityResult>(bun, "durability");
    });

    it("wrote a company, a run, two steps and a pending approval", () => {
      expect(result.beforeClose.stepCount).toBe(2);
      expect(result.beforeClose.approvalStatus).toBe("pending");
    });

    it("reads all four back from a brand new client on the same file", () => {
      // This is what makes `--continue` resume a real run rather than an orphan transcript.
      expect(result.afterReopen.companyFound).toBe(true);
      expect(result.afterReopen.companyName).toBe("Durable Co");
      expect(result.afterReopen.runFound).toBe(true);
      expect(result.afterReopen.runStatus).toBe("running");
      expect(result.afterReopen.runObjective).toBe("prove --continue can resume a real run");
      expect(result.afterReopen.stepTitles).toEqual(["draft the plan", "execute the plan"]);
      expect(result.afterReopen.approvalFound).toBe(true);
    });

    it("keeps the approval pending across the restart", () => {
      expect(result.afterReopen.approvalStatus).toBe("pending");
    });

    it("replays the event log and the job runs too", () => {
      expect(result.afterReopen.eventKinds).toEqual(["step_start", "step_end"]);
      expect(result.afterReopen.jobRunCount).toBe(1);
    });

    it("cascade-deletes every child when the company goes", () => {
      expect(result.afterCascadeDelete).toEqual({
        companyFound: false,
        runFound: false,
        stepCount: 0,
        eventCount: 0,
        approvalFound: false,
      });
    });
  });

  describe("concurrency hardening (C4)", () => {
    let result: ConcurrencyResult;
    beforeAll(() => {
      result = runScenario<ConcurrencyResult>(bun, "concurrency");
    });

    it("lets two connections write the same file without SQLITE_BUSY", () => {
      expect(result.error).toBeNull();
      expect(result.eventsSeen).toBe(result.writes);
    });

    it("connects in WAL mode with a busy timeout", () => {
      expect(result.journalMode).toBe("wal");
      expect(result.busyTimeoutMs).toBeGreaterThan(0);
    });
  });

  describe("transaction semantics", () => {
    let result: TransactionResult;
    beforeAll(() => {
      result = runScenario<TransactionResult>(bun, "transaction");
    });

    it("commits an interactive transaction without P2028", () => {
      expect(result.error).toBeNull();
      expect(result.committed).toBe(2);
    });

    it("rolls back and leaves nothing behind", () => {
      expect(result.rolledBack).toBe(true);
      expect(result.afterRollback).toBe(2);
    });
  });
});
