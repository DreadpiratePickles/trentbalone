/**
 * 3.8, the sixteenth checklist item — an approval must survive a restart.
 *
 * Two separate OS processes share one SQLite file. The first opens an approval and
 * exits; the second, with no shared memory whatsoever, restores the gate and finds the
 * approval still pending and still answerable.
 *
 * This runs under Bun because the store's driver adapter is bun:sqlite; the pattern
 * mirrors packages/trent-core/src/store/store.durability.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "approval-restart-runner.ts");

function findBun(): string {
  const fromEnv = process.env.TRENT_BUN_BIN;
  if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) return fromEnv;
  try {
    const onPath = execSync("command -v bun", { encoding: "utf8" }).trim();
    if (onPath !== "") return onPath;
  } catch {
    /* fall through */
  }
  const standard = path.join(homedir(), ".bun", "bin", "bun");
  if (existsSync(standard)) return standard;
  throw new Error("bun not found; set TRENT_BUN_BIN or put bun on PATH");
}

interface OpenResult {
  approvalId: string;
  blocking: boolean;
  pending: number;
}
interface ResumeResult {
  blockingAfterRestore: boolean;
  pendingCount: number;
  action: string | null;
  reason: string | null;
  statusAfterAnswer: string | null;
  blockingAfterAnswer: boolean;
  pendingAfterAnswer: number;
}

describe("an approval survives a restart", () => {
  let bun = "";
  let file = "";
  let opened: OpenResult;
  let resumed: ResumeResult;

  beforeAll(() => {
    bun = findBun();
    file = path.join(mkdtempSync(path.join(tmpdir(), "trent-repl-approval-")), "trent.db");
    const phase = <T>(name: string): T =>
      JSON.parse(
        execFileSync(bun, [runner, name, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      ) as T;
    opened = phase<OpenResult>("open");
    resumed = phase<ResumeResult>("resume");
  }, 120_000);

  it("blocks input in the process that opened it", () => {
    expect(opened.approvalId).toMatch(/./);
    expect(opened.blocking).toBe(true);
    expect(opened.pending).toBe(1);
  });

  it("is still pending in a brand new process", () => {
    expect(resumed.pendingCount).toBe(1);
    expect(resumed.blockingAfterRestore).toBe(true);
    expect(resumed.action).toBe("deploy the release");
    expect(resumed.reason).toBe("production change requires a human");
  });

  it("is answerable after the restart, and stops blocking once answered", () => {
    expect(resumed.statusAfterAnswer).toBe("approved");
    expect(resumed.blockingAfterAnswer).toBe(false);
    expect(resumed.pendingAfterAnswer).toBe(0);
  });
});
