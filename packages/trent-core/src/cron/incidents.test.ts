/**
 * [X4] Cron failure incidents and the quota hold. A job that fails `failureAlertAfter` times in a
 * row raises exactly one alert through the injected owner path, marked `[CRON_FAILURE]`, and is
 * an open incident until acknowledged; every further failure is counted, never alerted. A
 * provider 429 on any job sets `quota_hold_until` (Retry-After, else the configured minutes) and
 * a tick under the hold skips every prompt-driven job, logging the hold once; a handled job
 * (no model) still runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderHttpError } from "../model-gateway/retry.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { newCronJob, readCronJobs, writeCronJobs, type CronJob } from "../tools/cron/index.js";
import { CronRunner } from "./CronRunner.js";
import { acknowledgeIncident, openIncidents, readCronIncidents } from "./incidents.js";

let profileDir: string;
let clock: Date;
const now = (): Date => new Date(clock);

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cron-incidents-"));
  clock = new Date("2026-09-20T09:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_cron", at: clock.toISOString(), ...extra } as OrcEvent;
}

type Outcome = { events: OrcEvent[] } | { throws: Error };

interface Fake {
  runner: CronRunner;
  alerts: string[];
  logs: string[];
  launches: string[];
  handled: string[];
}

/** A runner whose `run` answers from a queue of outcomes, oldest first; the last one repeats. */
function fake(outcomes: Outcome[], options: { failureAlertAfter?: number; quotaHoldMinutes?: number; alertThrows?: boolean } = {}): Fake {
  const alerts: string[] = [];
  const logs: string[] = [];
  const launches: string[] = [];
  const handled: string[] = [];
  const queue = [...outcomes];
  const runner = new CronRunner({
    profileDir,
    now,
    log: (line) => logs.push(line),
    failureAlertAfter: options.failureAlertAfter,
    quotaHoldMinutes: options.quotaHoldMinutes,
    alert: async (text) => {
      if (options.alertThrows === true) throw new Error("owner unreachable");
      alerts.push(text);
    },
    handlers: {
      counted: async (job) => {
        handled.push(job.id);
        return { summary: "handled" };
      },
    },
    run: (prompt) => {
      launches.push(prompt);
      const outcome = queue.length > 1 ? queue.shift()! : queue[0]!;
      if ("throws" in outcome) throw outcome.throws;
      return (async function* () {
        for (const event of outcome.events) yield event;
      })();
    },
  });
  return { runner, alerts, logs, launches, handled };
}

const failed = (detail: string): Outcome => ({ events: [ev("run_start"), ev("run_failed", { detail })] });
const done = (): Outcome => ({ events: [ev("run_start"), ev("run_done", { run: { status: "completed", summary: "fine" } })] });

function schedule(job: Partial<CronJob> = {}): CronJob {
  const base = newCronJob({ schedule: "* * * * *", prompt: "count the deals" }, clock.toISOString());
  const row: CronJob = { ...base, next_run_at: clock.toISOString(), ...job };
  writeCronJobs(profileDir, [...readCronJobs(profileDir), row]);
  return row;
}

async function tickTimes(runner: CronRunner, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    clock = new Date(clock.getTime() + 60_000);
    await runner.tick();
  }
}

describe("cron failure incidents", () => {
  it("three consecutive failures raise one alert with the marker, a fourth raises none, and ack resets the streak", async () => {
    const job = schedule();
    const f = fake([failed("the seat could not read the pipeline")]);

    await tickTimes(f.runner, 2);
    expect(f.alerts).toEqual([]);
    expect(openIncidents(profileDir)).toEqual([]);
    expect(readCronIncidents(profileDir).jobs[job.id]?.failures).toBe(2);

    await tickTimes(f.runner, 1);
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toContain("[CRON_FAILURE]");
    expect(f.alerts[0]).toContain(job.id);
    expect(f.alerts[0]).toContain("the seat could not read the pipeline");
    expect(f.alerts[0]).toContain(`trent cron incidents ack ${job.id}`);
    const [incident] = openIncidents(profileDir);
    expect(incident).toMatchObject({ jobId: job.id, failures: 3, alerted: true });

    await tickTimes(f.runner, 2);
    expect(f.alerts).toHaveLength(1);
    expect(openIncidents(profileDir)[0]).toMatchObject({ jobId: job.id, failures: 5 });
    expect(f.logs.filter((line) => line.includes("cron.incident.opened"))).toHaveLength(1);

    expect(acknowledgeIncident(profileDir, job.id, "bobby", now())).toMatchObject({ jobId: job.id, failures: 5 });
    expect(openIncidents(profileDir)).toEqual([]);
    expect(readCronIncidents(profileDir).jobs[job.id]).toBeUndefined();
    expect(acknowledgeIncident(profileDir, job.id, "bobby", now())).toBeUndefined();

    // After the ack the count starts again: three more failures alert again, exactly once.
    await tickTimes(f.runner, 3);
    expect(f.alerts).toHaveLength(2);
  });

  it("a success resets the streak, so failures either side of it never add up to an alert", async () => {
    schedule();
    const f = fake([failed("one"), failed("two"), done(), failed("three"), failed("four")]);
    await tickTimes(f.runner, 5);
    expect(f.alerts).toEqual([]);
    expect(openIncidents(profileDir)).toEqual([]);
  });

  it("the threshold comes from failureAlertAfter, and an alert that cannot be sent still opens the incident once", async () => {
    const job = schedule();
    const f = fake([failed("no route")], { failureAlertAfter: 1, alertThrows: true });
    await tickTimes(f.runner, 2);
    expect(f.alerts).toEqual([]);
    expect(openIncidents(profileDir)).toHaveLength(1);
    expect(openIncidents(profileDir)[0]).toMatchObject({ jobId: job.id, failures: 2, alerted: false });
    expect(f.logs.filter((line) => line.includes("cron.incident.alert_failed"))).toHaveLength(1);
  });

  it("a manual run's failure is not a scheduled incident, but its success clears the streak", async () => {
    const job = schedule();
    const f = fake([failed("a"), failed("b"), done(), failed("c")]);
    await tickTimes(f.runner, 2);
    expect(readCronIncidents(profileDir).jobs[job.id]?.failures).toBe(2);
    await f.runner.runNow(job.id);
    expect(readCronIncidents(profileDir).jobs[job.id]).toBeUndefined();
    await f.runner.runNow(job.id);
    expect(readCronIncidents(profileDir).jobs[job.id]).toBeUndefined();
  });
});

describe("the quota hold", () => {
  it("a 429 with Retry-After sets quota_hold_until from the header, and the next tick skips prompt jobs with one log line", async () => {
    const prompt = schedule();
    const handled = schedule({ id: "job_handled000", handler: "counted", prompt: "publish" });
    const f = fake([{ throws: new ProviderHttpError({ provider: "google", status: 429, headers: { "retry-after": "600" } }) }, done()]);

    await tickTimes(f.runner, 1);
    expect(f.launches).toHaveLength(1);
    expect(f.handled).toEqual([handled.id]);
    const state = readCronIncidents(profileDir);
    expect(state.quota_hold_until).toBe(new Date(clock.getTime() + 600_000).toISOString());

    const before = f.logs.length;
    await tickTimes(f.runner, 1);
    expect(f.launches).toHaveLength(1);
    expect(f.handled).toEqual([handled.id, handled.id]);
    const holdLines = f.logs.slice(before).filter((line) => line.includes("cron.quota_hold"));
    expect(holdLines).toHaveLength(1);
    expect(holdLines[0]).toContain(state.quota_hold_until);
    // The skipped job keeps its slot: nothing was stamped, so it fires once the hold lifts.
    expect(readCronJobs(profileDir).find((j) => j.id === prompt.id)!.next_run_at).toBe(clock.toISOString());

    await tickTimes(f.runner, 1);
    expect(f.launches).toHaveLength(1);
    expect(f.logs.filter((line) => line.includes("cron.quota_hold"))).toHaveLength(1);

    clock = new Date(clock.getTime() + 600_000);
    await f.runner.tick();
    expect(f.launches).toHaveLength(2);
    expect(readCronIncidents(profileDir).quota_hold_until).toBeUndefined();
  });

  it("a 429 reported on the run's event stream holds for quotaHoldMinutes when no Retry-After is known", async () => {
    schedule();
    const f = fake([failed("google request failed with HTTP 429 Too Many Requests"), done()], { quotaHoldMinutes: 15 });
    await tickTimes(f.runner, 1);
    expect(readCronIncidents(profileDir).quota_hold_until).toBe(new Date(clock.getTime() + 15 * 60_000).toISOString());
    await tickTimes(f.runner, 1);
    expect(f.launches).toHaveLength(1);
  });

  it("a failure that is not a rate limit sets no hold", async () => {
    schedule();
    const f = fake([failed("the seat could not read the pipeline")]);
    await tickTimes(f.runner, 1);
    expect(readCronIncidents(profileDir).quota_hold_until).toBeUndefined();
    await tickTimes(f.runner, 1);
    expect(f.launches).toHaveLength(2);
  });
});
