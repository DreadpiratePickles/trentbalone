import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { DoctorRunner, doctorExitCode, renderJsonReport } from "./DoctorRunner.js";
import { EXIT } from "../errors/index.js";
import type { CheckResult, DoctorCheck, DoctorReport } from "./types.js";

/** Anything outside the BMP plus the common symbol blocks: no emoji is allowed in output. */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

function stubCheck(id: string, result: Partial<CheckResult>): DoctorCheck {
  return {
    id,
    name: id,
    category: id,
    async run(): Promise<CheckResult> {
      return { category: id, name: id, status: "ok", message: `${id} fine`, ...result };
    },
  };
}

describe("DoctorRunner", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let doctor: DoctorRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    doctor = new DoctorRunner(configManager, { probeTimeoutMs: 150, checkTimeoutMs: 3000 });
    vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
    vi.stubEnv("REDIS_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers every check exactly once and reports a complete result set", async () => {
    const report = await doctor.runAll();
    expect(report.results).toHaveLength(report.total);
    const categories = report.results.map((r) => r.category);
    expect(new Set(categories).size).toBe(categories.length);
    for (const expected of [
      "Config",
      "Credentials",
      "Environment",
      "Agents",
      "Skills",
      "MCP",
      "Connectivity",
      "Database",
      "Cron",
      "Disk",
      "Dependencies",
      "Workbench",
      "Self-Improvement",
      "Local Model",
    ]) {
      expect(categories, expected).toContain(expected);
    }
  }, 30000);

  it("gives every failing or warning check a fixHint", async () => {
    const report = await doctor.runAll();
    const actionable = report.results.filter((r) => r.status === "warn" || r.status === "fail");
    expect(actionable.length).toBeGreaterThan(0);
    for (const result of actionable) {
      expect(result.fixHint, `${result.category} has no fixHint`).toBeTruthy();
    }
  }, 30000);

  it("emits no emoji anywhere in the rendered report", async () => {
    const report = await doctor.runAll();
    const text = doctor.formatReport(report);
    expect(EMOJI.test(text)).toBe(false);
    for (const result of report.results) {
      expect(EMOJI.test(result.message), result.category).toBe(false);
    }
  }, 30000);

  it("exits 0 when everything passes", async () => {
    const runner = new DoctorRunner(configManager, { checks: [stubCheck("A", {}), stubCheck("B", {})] });
    const report = await runner.runAll();
    expect(doctorExitCode(report)).toBe(EXIT.OK);
  });

  it("exits 0 when there are warnings but no failures", async () => {
    const runner = new DoctorRunner(configManager, {
      checks: [stubCheck("A", { status: "warn", fixHint: "do the thing" })],
    });
    const report = await runner.runAll();
    expect(report.warnings).toBe(1);
    expect(doctorExitCode(report)).toBe(EXIT.OK);
  });

  it("exits 3 when any check fails", async () => {
    const runner = new DoctorRunner(configManager, {
      checks: [stubCheck("A", {}), stubCheck("B", { status: "fail", fixHint: "fix it" })],
    });
    const report = await runner.runAll();
    expect(doctorExitCode(report)).toBe(EXIT.CONFIG);
  });

  it("emits parseable JSON containing every check", async () => {
    const runner = new DoctorRunner(configManager, {
      checks: [stubCheck("A", {}), stubCheck("B", { status: "fail", fixHint: "fix it" })],
    });
    const report = await runner.runAll();
    const parsed = JSON.parse(renderJsonReport(report)) as DoctorReport & { exitCode: number };
    expect(parsed.results.map((r) => r.category).sort()).toEqual(["A", "B"]);
    expect(parsed.total).toBe(2);
    expect(parsed.exitCode).toBe(EXIT.CONFIG);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("does not hang on a check that never resolves; it reports it as timed out", async () => {
    const wedged: DoctorCheck = {
      id: "wedged",
      name: "Wedged Check",
      category: "Wedged",
      run: () => new Promise<CheckResult>(() => {}),
    };
    const runner = new DoctorRunner(configManager, {
      checks: [stubCheck("A", {}), wedged],
      checkTimeoutMs: 100,
    });
    const started = Date.now();
    const report = await runner.runAll();
    expect(Date.now() - started).toBeLessThan(5000);
    const wedgedResult = report.results.find((r) => r.category === "Wedged");
    expect(wedgedResult?.status).toBe("fail");
    expect(wedgedResult?.message.toLowerCase()).toContain("timed out");
    expect(report.results).toHaveLength(2);
  });

  it("enforces a whole-run deadline even if many checks wedge", async () => {
    const wedged = (id: string): DoctorCheck => ({
      id,
      name: id,
      category: id,
      run: () => new Promise<CheckResult>(() => {}),
    });
    const runner = new DoctorRunner(configManager, {
      checks: [wedged("W1"), wedged("W2"), wedged("W3")],
      checkTimeoutMs: 10_000,
      totalTimeoutMs: 200,
    });
    const started = Date.now();
    const report = await runner.runAll();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.status === "fail")).toBe(true);
    expect(doctorExitCode(report)).toBe(EXIT.CONFIG);
  });

  it("gives a check that declares its own budget that budget, and grows the run deadline so later checks still run", async () => {
    // A local model's cold prefill is slow by design; the check brings its own time instead of
    // borrowing it from the checks after it.
    const slow: DoctorCheck = {
      id: "slow",
      name: "Slow",
      category: "Slow",
      timeoutMs: 1_000,
      run: () => new Promise<CheckResult>((resolve) => setTimeout(() => resolve({ category: "Slow", name: "Slow", status: "ok", message: "slow fine" }), 300)),
    };
    const runner = new DoctorRunner(configManager, {
      checks: [slow, stubCheck("After", {})],
      checkTimeoutMs: 100,
      totalTimeoutMs: 150,
    });
    const report = await runner.runAll();
    expect(report.results.map((r) => [r.category, r.status])).toEqual([["Slow", "ok"], ["After", "ok"]]);
  });

  it("still bounds a check that declares its own budget", async () => {
    const wedged: DoctorCheck = { id: "w", name: "W", category: "W", timeoutMs: 120, run: () => new Promise<CheckResult>(() => {}) };
    const started = Date.now();
    const report = await new DoctorRunner(configManager, { checks: [wedged], checkTimeoutMs: 10_000 }).runAll();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(report.results[0]?.status).toBe("fail");
    expect(report.results[0]?.details).toMatchObject({ timeoutMs: 120 });
  });

  it("turns a throwing check into a failure rather than crashing the run", async () => {
    const thrower: DoctorCheck = {
      id: "boom",
      name: "boom",
      category: "Boom",
      async run(): Promise<CheckResult> {
        throw new Error("kaboom");
      },
    };
    const report = await new DoctorRunner(configManager, { checks: [thrower] }).runAll();
    expect(report.results[0]?.status).toBe("fail");
    expect(report.results[0]?.message).toContain("kaboom");
  });
});
