/**
 * `trent jobs failed|retry`: the failed-jobs view over the profile store and the re-launch of a
 * failed job's objective through the headless runtime (a fake here, so no proxy, sandbox or model).
 * The runtime seam is the same one `heartbeat start` and `gateway start` use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-jobs-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

interface SeededJob {
  id: string;
  type: string;
  status: string;
  companyId: string | null;
  trigger: string;
  summary: string;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  metadata?: Record<string, unknown>;
}

const COMPANY = "cmp_local";

const FAILED: SeededJob = {
  id: "job_fail",
  type: "orchestration_step",
  status: "failed",
  companyId: COMPANY,
  trigger: "system",
  summary: "Orchestration step failed.",
  error: "provider returned 429",
  startedAt: new Date("2026-09-15T09:00:00.000Z"),
  completedAt: new Date("2026-09-15T09:01:00.000Z"),
  metadata: { runId: "run_old", action: "execute_step", stepId: "step_1" },
};

const OLDER_FAILED: SeededJob = {
  ...FAILED,
  id: "job_fail_older",
  error: "planner timed out",
  startedAt: new Date("2026-09-14T09:00:00.000Z"),
  completedAt: new Date("2026-09-14T09:00:30.000Z"),
  metadata: {},
};

const COMPLETED: SeededJob = {
  id: "job_ok",
  type: "orchestration_step",
  status: "completed",
  companyId: COMPANY,
  trigger: "system",
  summary: "Completed orchestration consolidate.",
  error: null,
  startedAt: new Date("2026-09-15T10:00:00.000Z"),
  completedAt: new Date("2026-09-15T10:02:00.000Z"),
};

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_new", at: "2026-09-15T11:00:00.000Z", ...extra } as OrcEvent;
}

interface Fakes {
  overrides: CliOverrides;
  built: number;
  runs: Array<{ objective: string; trigger: string }>;
  created: Array<Record<string, unknown>>;
  cleanup: ReturnType<typeof vi.fn>;
}

function fakes(rows: SeededJob[] = [FAILED, COMPLETED, OLDER_FAILED], outcome: OrcEvent["kind"] = "run_done"): Fakes {
  const f: Fakes = { overrides: {}, built: 0, runs: [], created: [], cleanup: vi.fn(async () => undefined) };
  const store = {
    listJobRuns: async (companyId: string | null, limit = 50) => rows.filter((r) => r.companyId === companyId).slice(0, limit),
    getRun: async (id: string) => (id === "run_old" ? { id, companyId: COMPANY, objective: "Ship the launch email", status: "failed", summary: null, startedAt: FAILED.startedAt } : null),
    createJobRun: async (input: Record<string, unknown>) => {
      f.created.push(input);
      return { id: "job_link", type: input.type, status: "completed", companyId: COMPANY, summary: input.summary ?? "", startedAt: new Date() };
    },
  };
  const runtime = {
    companyId: COMPANY,
    store,
    run: (objective: string, options: { trigger: string }) => {
      f.runs.push({ objective, trigger: options.trigger });
      const stream = [ev("run_start"), ev(outcome, { run: { status: outcome === "run_done" ? "completed" : "failed", summary: "retried and done" } })];
      return (async function* () {
        for (const event of stream) yield event;
      })();
    },
    cleanup: f.cleanup,
  } as unknown as HeadlessRuntime;
  f.overrides = {
    gatewayRuntime: async () => {
      f.built += 1;
      return runtime;
    },
  };
  return f;
}

type FailedData = { count: number; durable: boolean; jobs: Array<{ id: string; type: string; trigger: string; finishedAt: string | null; error: string | null; summary: string }> };

describe("trent jobs failed", () => {
  it("--json lists exactly the failed rows, newest first, with id, type, trigger, finishedAt and error", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "failed", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as FailedData;
    expect(data.jobs.map((j) => j.id)).toEqual(["job_fail", "job_fail_older"]);
    expect(data.jobs[0]).toEqual({
      id: "job_fail",
      type: "orchestration_step",
      trigger: "system",
      finishedAt: "2026-09-15T09:01:00.000Z",
      error: "provider returned 429",
      summary: "Orchestration step failed.",
    });
    expect(data.count).toBe(2);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("--last N keeps only the newest N failures", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "failed", "--last", "1", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(result.stdout) as FailedData).jobs.map((j) => j.id)).toEqual(["job_fail"]);
  });

  it("--dry-run --json exits 0 without building the runtime", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "failed", "--dry-run", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "jobs failed" });
    expect(f.built).toBe(0);
  });

  it("renders the failures as text with the error on each line", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "failed", "--no-color"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("FAILED JOBS (2)");
    expect(result.stdout).toContain("job_fail");
    expect(result.stdout).toContain("provider returned 429");
    expect(result.stdout).not.toContain("job_ok");
  });
});

describe("trent jobs retry", () => {
  it("--dry-run --json exits 0 and names the job without building the runtime", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "retry", "job_fail", "--dry-run", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toEqual({ dryRun: true, command: "jobs retry", jobId: "job_fail", objective: null });
    expect(f.built).toBe(0);
  });

  it("re-launches the failed job's run objective through the runtime as a manual run and records the link", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "retry", "job_fail", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.runs).toEqual([{ objective: "Ship the launch email", trigger: "manual" }]);
    const data = JSON.parse(result.stdout) as { retryOf: string; objective: string; runId: string; status: string; summary: string | null; link: string };
    expect(data).toMatchObject({ retryOf: "job_fail", objective: "Ship the launch email", runId: "run_new", status: "completed", summary: "retried and done" });
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({ type: "orchestration_retry", trigger: "manual", companyId: COMPANY, metadata: { retryOf: "job_fail", runId: "run_new" } });
    expect(data.link).toBe("job_link");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("refuses an id that is not a failed job in this profile", async () => {
    const f = fakes();
    const result = await runCli(["jobs", "retry", "job_ok", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("job_ok");
    expect(f.runs).toEqual([]);
  });

  it("with no run link on the row it needs --objective, and says so", async () => {
    const f = fakes();
    const refused = await runCli(["jobs", "retry", "job_fail_older", "--json"], { overrides: f.overrides });
    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(refused.stdout).toContain("--objective");
    expect(f.runs).toEqual([]);

    const result = await runCli(["jobs", "retry", "job_fail_older", "--objective", "Draft the pricing page", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.runs).toEqual([{ objective: "Draft the pricing page", trigger: "manual" }]);
  });

  it("a retry that fails again reports the run's status and exits as a provider failure", async () => {
    const f = fakes([FAILED, COMPLETED], "run_failed");
    const result = await runCli(["jobs", "retry", "job_fail", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.PROVIDER);
    expect(JSON.parse(result.stdout)).toMatchObject({ retryOf: "job_fail", runId: "run_new", status: "failed" });
    expect(f.created).toHaveLength(1);
  });
});
