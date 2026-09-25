/**
 * The cron runner over `<profile>/cron/jobs.json`: a fake clock and a fake `run` prove that a due
 * job launches exactly once per schedule slot, that the schedule fields are persisted BEFORE the
 * launch (so a crash mid-run never double-fires on restart), that every run leaves a history row
 * under `<profile>/cron/runs/<jobId>.jsonl` capped at the limit, and that a job with `deliver`
 * hands the run's own summary to the injected delivery function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TrentError } from "../errors/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { cronRunnerActive, cronRunnerLockPath, newCronJob, readCronJobs, writeCronJobs, type CronJob } from "../tools/cron/index.js";
import { liveWriters } from "../profile/locks.js";
import { CronRunner, cronRunsPath, readCronRuns, type CronRunRow } from "./CronRunner.js";

let profileDir: string;
let clock: Date;
const now = (): Date => new Date(clock);

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cron-runner-"));
  clock = new Date("2026-09-15T09:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_cron", at: clock.toISOString(), ...extra } as OrcEvent;
}

const completed = (summary: string): OrcEvent[] => [
  ev("run_start"),
  ev("step_end", { step: { id: "s1", costCents: 7 } }),
  ev("consolidate_end", { run: { summary } }),
  ev("run_done", { run: { status: "completed", summary } }),
];

const summaryFor = (prompt: string): OrcEvent[] => completed(`brief: ${prompt}`);

interface Fake {
  runner: CronRunner;
  launches: Array<{ prompt: string; trigger: string }>;
  deliveries: Array<{ target: string; text: string }>;
  logs: string[];
}

function fake(opts: { events?: (prompt: string) => OrcEvent[]; throwOnRun?: Error; historyLimit?: number } = {}): Fake {
  const launches: Fake["launches"] = [];
  const deliveries: Fake["deliveries"] = [];
  const logs: string[] = [];
  const runner = new CronRunner({
    profileDir,
    now,
    historyLimit: opts.historyLimit,
    log: (line) => logs.push(line),
    run: (prompt, options) => {
      launches.push({ prompt, trigger: options.trigger });
      if (opts.throwOnRun) throw opts.throwOnRun;
      const events = (opts.events ?? summaryFor)(prompt);
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    deliver: async (target, text) => {
      deliveries.push({ target, text });
    },
  });
  return { runner, launches, deliveries, logs };
}

/** A job whose schedule slot is already due at `clock`. */
function dueJob(extra: Partial<CronJob> = {}): CronJob {
  const job = newCronJob({ schedule: "0 9 * * 1-5", prompt: "summarise yesterday's pipeline", deliver: "slack:#sales" }, "2026-09-14T09:00:00.000Z");
  const row = { ...job, next_run_at: "2026-09-15T09:00:00.000Z", ...extra };
  writeCronJobs(profileDir, [...readCronJobs(profileDir), row]);
  return row;
}

describe("CronRunner.tick", () => {
  it("launches a due job exactly once, with trigger scheduled, and not again in the same slot", async () => {
    const job = dueJob();
    const f = fake();
    expect(await f.runner.tick()).toEqual({ launched: [job.id] });
    expect(f.launches).toEqual([{ prompt: job.prompt, trigger: "scheduled" }]);

    clock = new Date("2026-09-15T09:00:30.000Z");
    expect(await f.runner.tick()).toEqual({ launched: [] });
    expect(f.launches).toHaveLength(1);

    const stored = readCronJobs(profileDir)[0]!;
    expect(stored.last_run_at).toBe("2026-09-15T09:00:00.000Z");
    expect(stored.next_run_at).toBe("2026-09-16T09:00:00.000Z");

    clock = new Date("2026-09-16T09:00:05.000Z");
    expect(await f.runner.tick()).toEqual({ launched: [job.id] });
    expect(f.launches).toHaveLength(2);
  });

  it("a job with no next_run_at gets one computed from its schedule and is not fired this tick", async () => {
    const job = newCronJob({ schedule: "*/15 * * * *", prompt: "count open deals" }, "2026-09-01T00:00:00.000Z");
    writeCronJobs(profileDir, [job]);
    const f = fake();
    expect(await f.runner.tick()).toEqual({ launched: [] });
    expect(readCronJobs(profileDir)[0]!.next_run_at).toBe("2026-09-15T09:15:00.000Z");
    clock = new Date("2026-09-15T09:15:00.000Z");
    expect(await f.runner.tick()).toEqual({ launched: [job.id] });
  });

  it("a paused job never launches; a run request from the tool fires once and is cleared", async () => {
    const paused = dueJob({ enabled: false });
    const requested = dueJob({ next_run_at: "2026-09-16T09:00:00.000Z", run_requested_at: "2026-09-15T08:59:00.000Z" });
    const f = fake();
    expect(await f.runner.tick()).toEqual({ launched: [requested.id] });
    const stored = readCronJobs(profileDir);
    expect(stored.find((j) => j.id === paused.id)?.last_run_at).toBeUndefined();
    expect(stored.find((j) => j.id === requested.id)?.run_requested_at).toBeUndefined();
    expect(await f.runner.tick()).toEqual({ launched: [] });
  });

  it("appends a history row with the run's summary and cost, and delivers the summary to the job's target", async () => {
    const job = dueJob();
    const f = fake();
    await f.runner.tick();
    const rows = readCronRuns(profileDir, job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      startedAt: "2026-09-15T09:00:00.000Z",
      endedAt: "2026-09-15T09:00:00.000Z",
      status: "completed",
      trigger: "scheduled",
      summary: "brief: summarise yesterday's pipeline",
      costCents: 7,
    } satisfies CronRunRow);
    expect(f.deliveries).toEqual([{ target: "slack:#sales", text: "brief: summarise yesterday's pipeline" }]);
    expect(fs.existsSync(cronRunsPath(profileDir, job.id))).toBe(true);
    expect(f.runner.history(job.id, 10)).toEqual(rows);
    // The log names the job and the outcome, never the prompt.
    expect(f.logs.join("\n")).toContain(job.id);
    expect(f.logs.join("\n")).not.toContain("summarise yesterday");
  });

  it("a run that yields run_failed records status failed with the failure detail; nothing is delivered", async () => {
    const job = dueJob();
    const f = fake({ events: () => [ev("run_start"), ev("run_failed", { detail: "provider returned 429" })] });
    await f.runner.tick();
    const rows = readCronRuns(profileDir, job.id);
    expect(rows[0]).toMatchObject({ status: "failed", summary: "Run failed: provider returned 429" });
    expect(f.deliveries).toEqual([]);
  });

  it("a crash after the persist does not re-fire the job on a fresh runner until its next slot", async () => {
    const job = dueJob();
    const crashed = fake({ throwOnRun: new Error("process died") });
    expect(await crashed.runner.tick()).toEqual({ launched: [job.id] });
    expect(readCronRuns(profileDir, job.id)[0]).toMatchObject({ status: "failed" });

    clock = new Date("2026-09-15T09:00:40.000Z");
    const restarted = fake();
    expect(await restarted.runner.tick()).toEqual({ launched: [] });
    expect(restarted.launches).toEqual([]);

    clock = new Date("2026-09-16T09:00:00.000Z");
    expect(await restarted.runner.tick()).toEqual({ launched: [job.id] });
  });

  it("history is capped at historyLimit, oldest rows dropped", async () => {
    const job = dueJob({ schedule: "* * * * *" });
    const f = fake({ historyLimit: 3 });
    for (let minute = 0; minute < 5; minute += 1) {
      clock = new Date(`2026-09-15T09:0${minute}:00.000Z`);
      await f.runner.tick();
    }
    expect(f.launches).toHaveLength(5);
    const rows = readCronRuns(profileDir, job.id);
    expect(rows.map((r) => r.startedAt)).toEqual(["2026-09-15T09:02:00.000Z", "2026-09-15T09:03:00.000Z", "2026-09-15T09:04:00.000Z"]);
    expect(f.runner.history(job.id, 2).map((r) => r.startedAt)).toEqual(["2026-09-15T09:03:00.000Z", "2026-09-15T09:04:00.000Z"]);
  });

  it("a delivery failure is logged and recorded on the row; the run itself still counts as completed", async () => {
    const job = dueJob();
    const runner = new CronRunner({
      profileDir,
      now,
      run: () => (async function* () { for (const e of completed("ok")) yield e; })(),
      deliver: async () => { throw new Error("slack: channel_not_found"); },
      log: () => undefined,
    });
    await runner.tick();
    expect(readCronRuns(profileDir, job.id)[0]).toMatchObject({ status: "completed", deliveryError: "slack: channel_not_found" });
  });
});

describe("CronRunner.runNow", () => {
  it("runs the job immediately with trigger scheduled, records a manual history row, and leaves the schedule alone", async () => {
    const job = dueJob({ next_run_at: "2026-09-16T09:00:00.000Z" });
    const f = fake();
    const row = await f.runner.runNow(job.id);
    expect(row).toMatchObject({ status: "completed", trigger: "manual", summary: "brief: summarise yesterday's pipeline" });
    expect(f.launches).toEqual([{ prompt: job.prompt, trigger: "scheduled" }]);
    expect(readCronJobs(profileDir)[0]!.next_run_at).toBe("2026-09-16T09:00:00.000Z");
    expect(f.deliveries).toHaveLength(1);
  });

  it("an unknown id is a TrentError", async () => {
    const f = fake();
    await expect(f.runner.runNow("job_0000000000")).rejects.toThrow(TrentError);
  });
});

describe("CronRunner.start / stop", () => {
  it("start writes the lock with this pid, ticks on the interval, and stop removes the lock", async () => {
    vi.useFakeTimers();
    try {
      const job = dueJob();
      const f = fake();
      f.runner.start();
      expect(cronRunnerActive(profileDir)).toBe(true);
      expect(JSON.parse(fs.readFileSync(cronRunnerLockPath(profileDir), "utf8"))).toMatchObject({ pid: process.pid });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.launches.map((l) => l.prompt)).toEqual([job.prompt]);
      f.runner.stop();
      expect(fs.existsSync(cronRunnerLockPath(profileDir))).toBe(false);
      expect(cronRunnerActive(profileDir)).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.launches).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to start over a live lock held by another process; a stale lock is taken over", () => {
    fs.mkdirSync(path.dirname(cronRunnerLockPath(profileDir)), { recursive: true });
    fs.writeFileSync(cronRunnerLockPath(profileDir), JSON.stringify({ pid: process.pid, started_at: "2026-09-15T08:00:00.000Z" }));
    const f = fake();
    expect(() => f.runner.start()).toThrow(/already running/);

    fs.writeFileSync(cronRunnerLockPath(profileDir), JSON.stringify({ pid: 2_147_483_646, started_at: "2026-09-15T08:00:00.000Z" }));
    expect(cronRunnerActive(profileDir)).toBe(false);
    f.runner.start();
    expect(JSON.parse(fs.readFileSync(cronRunnerLockPath(profileDir), "utf8"))).toMatchObject({ pid: process.pid });
    f.runner.stop();
  });

  it("a running runner is a live writer on the profile, so maintenance refuses; stop releases it, a refused start holds nothing", () => {
    const f = fake();
    f.runner.start();
    try {
      expect(liveWriters(profileDir)).toEqual([expect.objectContaining({ pid: process.pid, label: "cron" })]);
    } finally {
      f.runner.stop();
    }
    expect(liveWriters(profileDir)).toEqual([]);

    fs.writeFileSync(cronRunnerLockPath(profileDir), JSON.stringify({ pid: process.pid, started_at: "2026-09-15T08:00:00.000Z" }));
    expect(() => fake().runner.start()).toThrow(/already running/);
    expect(liveWriters(profileDir)).toEqual([]);
  });
});
