/**
 * The CLI entry owns the queue-fallback default, so a user never has to export it.
 *
 * Without `TRENT_QUEUE_FALLBACK=disabled` the wrapped app's inline queue fallback races the CLI's
 * own drain loop and every job runs twice (`packages/trent-core/src/runtime/env.ts`). Every run
 * surface already applies that in-process, but the doctor reads the raw process environment, so a
 * fresh shell failed "Standalone Environment Contract" until the user exported the variable by hand
 * (public-readiness audit 2026-09-25, fix 5).
 *
 * These tests spawn the real entry (`apps/cli/src/index.ts`, the same file every build compiles)
 * in a minimal environment, the way a new user's shell would start it, and read the doctor's own
 * verdict for the environment contract. The check is looked up by the name the check itself
 * exports, never by a string spelled here.
 */

import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnvironment } from "@trent/core/doctor/checks/environment.js";
import type { CheckResult, DoctorReport } from "@trent/core/doctor/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI_ENTRY = path.join(REPO_ROOT, "apps/cli/src/index.ts");

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `trent doctor --json` from a clean environment: PATH and a throwaway HOME/TRENT_HOME only.
 * Nothing is inherited from this test process, so no provider key, no Redis URL, no NODE_ENV=test
 * and no TRENT_QUEUE_FALLBACK reach the child unless `extra` names them.
 */
function doctorEnvironmentCheck(extra: Record<string, string>): { exitCode: number | null; check: CheckResult } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-env-defaults-"));
  scratchDirs.push(home);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TRENT_HOME: path.join(home, ".trent"),
    TMPDIR: os.tmpdir(),
    NO_COLOR: "1",
    ...extra,
  };
  const child = spawnSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "doctor", "--json", "--timeout", "2000"], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 110_000,
  });
  expect(child.error, `spawning the CLI failed: ${String(child.error)}`).toBeUndefined();
  let report: DoctorReport;
  try {
    report = JSON.parse(child.stdout) as DoctorReport;
  } catch {
    throw new Error(`doctor --json did not print one JSON document (exit ${child.status}); stderr: ${child.stderr.slice(0, 2000)}`);
  }
  const check = report.results.find((result) => result.name === checkEnvironment.name);
  expect(check, "the doctor report has no environment-contract result").toBeDefined();
  return { exitCode: child.status, check: check! };
}

describe("the CLI entry defaults TRENT_QUEUE_FALLBACK", () => {
  it("passes the environment contract when the variable is not set at all", () => {
    const { check } = doctorEnvironmentCheck({});
    expect(check.status).toBe("ok");
    expect(check.details?.violations).toBeUndefined();
  }, 120_000);

  it("treats an empty value as unset, because an empty value still enables the fallback", () => {
    const { check } = doctorEnvironmentCheck({ TRENT_QUEUE_FALLBACK: "" });
    expect(check.status).toBe("ok");
  }, 120_000);

  it("never overrides a value the user set: an explicit non-disabled value still fails the contract", () => {
    const { check } = doctorEnvironmentCheck({ TRENT_QUEUE_FALLBACK: "enabled" });
    expect(check.status).toBe("fail");
    const violations = (check.details?.violations ?? []) as string[];
    expect(violations.some((line) => line.startsWith("TRENT_QUEUE_FALLBACK "))).toBe(true);
  }, 120_000);
});
