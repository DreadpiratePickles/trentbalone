/**
 * The heartbeat loop over `<profile>/HEARTBEAT.md`: a fake clock and a fake `run` prove that a
 * tick inside quiet hours makes no model call and records a `quiet` row, that a reply of exactly
 * `NO_REPLY` is swallowed and recorded, that any other reply is delivered once, verbatim, that
 * memory consolidation runs once per calendar day inside quiet hours and never outside, and that
 * the objective carries the checklist text and the fleet-state block. Rows live under
 * `<profile>/heartbeat/runs.jsonl`, capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HeartbeatConfigSchema, type HeartbeatConfig } from "../config/schema.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { emptyPhases, type AgentSweepReport, type SweepReport } from "../improve/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { HEARTBEAT_MD, NO_REPLY, DEFAULT_HEARTBEAT_MD, HeartbeatLoop, heartbeatLockPath, heartbeatRunsPath, heartbeatStatus, readHeartbeatRuns, type HeartbeatRunRow } from "./HeartbeatLoop.js";
import type { HeartbeatBudgetPort } from "./fleet-state.js";
import type { HeartbeatSweepRequest } from "./sweep-step.js";

let profileDir: string;
let clock: Date;
const now = (): Date => new Date(clock);

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-heartbeat-"));
  clock = new Date("2026-09-15T09:00:00.000Z");
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_hb", at: clock.toISOString(), ...extra } as OrcEvent;
}

const completed = (summary: string): OrcEvent[] => [
  ev("run_start"),
  ev("step_end", { step: { id: "s1", costCents: 3 } }),
  ev("consolidate_end", { run: { summary } }),
  ev("run_done", { run: { status: "completed", summary } }),
];

const OFFICE: HeartbeatConfig = {
  enabled: true,
  interval_minutes: 60,
  active_hours: { start: "08:00", end: "20:00", tz: "UTC" },
  consolidate_memory: true,
  sweep: { enabled: false },
  sweep_interval_hours: 24,
};

interface Fake {
  loop: HeartbeatLoop;
  launches: Array<{ objective: string; trigger: string }>;
  deliveries: string[];
  consolidations: string[];
  logs: string[];
  /** [D2] what the injected sweep port was asked for, in order. */
  sweeps: HeartbeatSweepRequest[];
}

interface FakeSweep {
  capCents: number;
  report: SweepReport;
  budget?: HeartbeatBudgetPort;
}

function fake(
  opts: { config?: HeartbeatConfig; reply?: string; events?: OrcEvent[]; throwOnRun?: Error; owner?: false; historyLimit?: number; sweep?: FakeSweep } = {},
): Fake {
  const launches: Fake["launches"] = [];
  const deliveries: string[] = [];
  const consolidations: string[] = [];
  const logs: string[] = [];
  const sweeps: HeartbeatSweepRequest[] = [];
  const sweep = opts.sweep;
  const loop = new HeartbeatLoop({
    ...(sweep === undefined
      ? {}
      : {
          sweep: {
            capCents: sweep.capCents,
            ...(sweep.budget === undefined ? {} : { budget: sweep.budget }),
            runSweep: async (request) => {
              sweeps.push(request);
              return sweep.report;
            },
          },
        }),
    profileDir,
    config: opts.config ?? OFFICE,
    owner: opts.owner === false ? undefined : { platform: "telegram", channelId: "555" },
    now,
    historyLimit: opts.historyLimit,
    log: (line) => logs.push(line),
    run: (objective, options) => {
      launches.push({ objective, trigger: options.trigger });
      if (opts.throwOnRun) throw opts.throwOnRun;
      const events = opts.events ?? completed(opts.reply ?? "Two approvals have waited since yesterday.");
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
    deliver: async (text) => {
      deliveries.push(text);
    },
    consolidate: async () => {
      consolidations.push(clock.toISOString());
      return { status: "unchanged" };
    },
  });
  return { loop, launches, deliveries, consolidations, logs, sweeps };
}

describe("HeartbeatLoop.tick", () => {
  it("inside quiet hours makes no model call and records a quiet row", async () => {
    clock = new Date("2026-09-15T23:00:00.000Z");
    const f = fake();
    const row = await f.loop.tick();
    expect(row).toMatchObject({ at: "2026-09-15T23:00:00.000Z", decision: "quiet" });
    expect(f.launches).toEqual([]);
    expect(f.deliveries).toEqual([]);
    expect(readHeartbeatRuns(profileDir)).toEqual([row]);
  });

  it("a reply of exactly NO_REPLY (whitespace tolerated) delivers nothing and records no_reply", async () => {
    const f = fake({ reply: `  ${NO_REPLY}\n` });
    const row = await f.loop.tick();
    expect(row).toMatchObject({ decision: "no_reply", costCents: 3 });
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.trigger).toBe("heartbeat");
    expect(f.deliveries).toEqual([]);
  });

  it("any other reply is delivered once, verbatim, to the owner and recorded with its length", async () => {
    const f = fake({ reply: "Two approvals have waited since yesterday." });
    const row = await f.loop.tick();
    expect(f.deliveries).toEqual(["Two approvals have waited since yesterday."]);
    expect(row).toMatchObject({ decision: "reply", chars: "Two approvals have waited since yesterday.".length });
    // The log carries the decision, never the reply body.
    expect(f.logs.join("\n")).toContain("reply");
    expect(f.logs.join("\n")).not.toContain("Two approvals");
  });

  it("with no owner configured the reply is kept on disk and the row says why it was not sent", async () => {
    const f = fake({ owner: false });
    const row = await f.loop.tick();
    expect(f.deliveries).toEqual([]);
    expect(row.decision).toBe("reply");
    expect(row.deliveryError).toMatch(/gateway\.owner/);
  });

  it("a failed or throwing run records failed with the reason and delivers nothing", async () => {
    const failed = fake({ events: [ev("run_start"), ev("run_failed", { detail: "provider returned 429" })] });
    expect(await failed.loop.tick()).toMatchObject({ decision: "failed", reason: "provider returned 429" });
    const threw = fake({ throwOnRun: new Error("no provider configured") });
    expect(await threw.loop.tick()).toMatchObject({ decision: "failed", reason: "no provider configured" });
    expect(failed.deliveries).toEqual([]);
    expect(threw.deliveries).toEqual([]);
  });

  it("the objective is HEARTBEAT.md plus the fleet-state block plus the NO_REPLY contract", async () => {
    fs.writeFileSync(path.join(profileDir, HEARTBEAT_MD), "# My checklist\n\n- Ask about the Berlin lead\n");
    fs.mkdirSync(path.join(profileDir, "cron", "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "cron", "runs", "job_abc.jsonl"),
      `${JSON.stringify({ startedAt: "2026-09-15T08:00:00.000Z", endedAt: "2026-09-15T08:01:00.000Z", status: "failed", trigger: "scheduled", summary: "Run failed: provider returned 429" })}\n`,
    );
    fs.writeFileSync(
      path.join(profileDir, "gateway.json"),
      JSON.stringify({ version: 1, pairings: [], pairingCodes: [], queue: [], cursors: {}, approvals: { a1: { id: "a1", status: "pending" }, a2: { id: "a2", status: "approved" } } }),
    );
    const f = fake({ reply: NO_REPLY });
    await f.loop.tick();
    const objective = f.launches[0]!.objective;
    expect(objective).toContain("Ask about the Berlin lead");
    expect(objective).toContain("Pending approvals: 1");
    expect(objective).toContain("job_abc");
    expect(objective).toContain("failed");
    expect(objective).toContain(`answer exactly ${NO_REPLY}`);
    expect(objective).toContain("Last heartbeat: none");

    // The second tick sees the first one's outcome.
    clock = new Date("2026-09-15T10:00:00.000Z");
    await f.loop.tick();
    expect(f.launches[1]!.objective).toContain("Last heartbeat: 2026-09-15T09:00:00.000Z no_reply");
  });

  it("without a HEARTBEAT.md the default checklist is the objective, and a budget port adds a budget line", async () => {
    const f = new HeartbeatLoop({
      profileDir,
      config: OFFICE,
      owner: { platform: "slack", channelId: "#founder" },
      now,
      run: (objective) => {
        seen.push(objective);
        return (async function* () {
          for (const e of completed(NO_REPLY)) yield e;
        })();
      },
      deliver: async () => undefined,
      state: { budget: { spentCents: () => 8_100, limitCents: () => 10_000 } },
    });
    const seen: string[] = [];
    await f.tick();
    expect(seen[0]).toContain(DEFAULT_HEARTBEAT_MD.trim());
    expect(seen[0]).toContain("Budget: $81.00 of $100.00 (81%)");
  });

  it("consolidates memory once per calendar day inside quiet hours, never outside, and marks the row", async () => {
    const f = fake();
    await f.loop.tick(); // 09:00, active
    expect(f.consolidations).toEqual([]);
    clock = new Date("2026-09-15T21:00:00.000Z");
    expect(await f.loop.tick()).toMatchObject({ decision: "quiet", consolidated: true });
    clock = new Date("2026-09-15T22:00:00.000Z");
    expect(await f.loop.tick()).toMatchObject({ decision: "quiet" });
    expect(f.consolidations).toEqual(["2026-09-15T21:00:00.000Z"]);
    clock = new Date("2026-09-16T05:00:00.000Z");
    await f.loop.tick();
    expect(f.consolidations).toEqual(["2026-09-15T21:00:00.000Z", "2026-09-16T05:00:00.000Z"]);

    // A fresh loop over the same profile learns the last consolidation day from the rows.
    clock = new Date("2026-09-16T06:00:00.000Z");
    const again = fake();
    await again.loop.tick();
    expect(again.consolidations).toEqual([]);
  });

  it("consolidation is off when consolidate_memory is false, and with no active hours it runs once a day at the first tick", async () => {
    const off = fake({ config: { ...OFFICE, consolidate_memory: false } });
    clock = new Date("2026-09-15T21:00:00.000Z");
    await off.loop.tick();
    expect(off.consolidations).toEqual([]);

    fs.rmSync(heartbeatRunsPath(profileDir), { force: true });
    const always = fake({ config: { ...OFFICE, active_hours: undefined }, reply: NO_REPLY });
    await always.loop.tick();
    clock = new Date("2026-09-15T22:00:00.000Z");
    await always.loop.tick();
    expect(always.consolidations).toEqual(["2026-09-15T21:00:00.000Z"]);
    expect(always.launches).toHaveLength(2);
  });

  it("keeps the newest historyLimit rows at mode 0600 and never launches two ticks at once", async () => {
    const f = fake({ historyLimit: 3, reply: NO_REPLY });
    for (let i = 0; i < 5; i += 1) {
      clock = new Date(clock.getTime() + 3_600_000);
      await f.loop.tick();
    }
    const rows = readHeartbeatRuns(profileDir);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.at).toBe("2026-09-15T14:00:00.000Z");
    expect(fs.statSync(heartbeatRunsPath(profileDir)).mode & 0o777).toBe(0o600);

    const [a, b] = await Promise.all([f.loop.tick(), f.loop.tick()]);
    expect(a).toBe(b);
  });
});

describe("HeartbeatLoop.start and heartbeatStatus", () => {
  it("ticks on the configured interval, holds the lock, refuses a second live loop, and stop releases it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const f = fake({ reply: NO_REPLY });
      f.loop.start();
      expect(f.loop.running).toBe(true);
      expect(() => fake().loop.start()).toThrow(/already running/);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(f.launches).toHaveLength(1);
      expect(fs.existsSync(heartbeatLockPath(profileDir))).toBe(true);
      f.loop.stop();
      expect(f.loop.running).toBe(false);
      expect(fs.existsSync(heartbeatLockPath(profileDir))).toBe(false);
      expect(() => fake().loop.start()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports enabled, interval, quiet-now, the last row and the next tick from the last row", async () => {
    const empty = heartbeatStatus(profileDir, OFFICE, now());
    expect(empty).toMatchObject({ enabled: true, intervalMinutes: 60, quietNow: false, last: null, nextTickAt: null });
    const f = fake({ reply: NO_REPLY });
    const row = await f.loop.tick();
    const status = heartbeatStatus(profileDir, OFFICE, now());
    expect(status.last).toEqual(row satisfies HeartbeatRunRow);
    expect(status.nextTickAt).toBe("2026-09-15T10:00:00.000Z");
    expect(heartbeatStatus(profileDir, OFFICE, new Date("2026-09-15T22:00:00.000Z")).quietNow).toBe(true);
  });
});

/**
 * [D2] The unattended sweep. The loop never calls `runImprovementSweep` itself: it calls an
 * injected port, so these tests prove the METERING and the GATES around the sweep — opt-in,
 * quiet hours, the interval, budget headroom — and that a sweep that ran is written to the
 * history and delivered down the same gateway path a reply takes. Nothing here promotes
 * anything: the record counts what waits for `trent improve promote`.
 */
const SWEEPING: HeartbeatConfig = { ...OFFICE, sweep: { enabled: true }, sweep_interval_hours: 24 };

function agentReport(over: Partial<AgentSweepReport> = {}): AgentSweepReport {
  return { agentId: "ceo", traces: 0, skillsDistilled: 0, skillsGated: 0, skillsRejected: 0, gepaPasses: 0, degradedSkills: [], degradedTools: [], skipped: [], errors: [], ...over };
}

function sweepReport(over: Partial<SweepReport> = {}): SweepReport {
  return {
    companyId: "cmp_local",
    at: "2026-09-15T09:00:00.000Z",
    passK: 3,
    judgeAdvisory: false,
    reflected: false,
    agents: [],
    skippedSpecialists: [],
    retirement: { stale: [], archived: [], kept: [] },
    costCents: 0,
    phases: emptyPhases(),
    budget: { limitCents: null, exhausted: false },
    errors: [],
    ...over,
  };
}

const DISTILLED = sweepReport({
  agents: [agentReport({ traces: 4, skillsDistilled: 2, skillsGated: 1, skillsRejected: 0, skipped: ["negotiation: unchanged"] })],
  costCents: 7,
  budget: { limitCents: 100, exhausted: false },
});

describe("HeartbeatLoop sweep step", () => {
  it("sweeps once when every condition holds, records the report, and delivers it to the owner", async () => {
    const f = fake({ config: SWEEPING, reply: NO_REPLY, sweep: { capCents: 100, report: DISTILLED } });
    const row = await f.loop.tick();
    expect(f.sweeps).toEqual([{ at: "2026-09-15T09:00:00.000Z", capCents: 100, trigger: "heartbeat" }]);
    expect(row.sweep).toMatchObject({ drafts: 2, awaitingPromotion: 1, quarantined: 1, rejected: 0, costCents: 7, capCents: 100, exhausted: false });
    expect(row.sweep?.blocked).toContain("ceo: negotiation: unchanged");
    expect(row.sweepSkipped).toBeUndefined();
    expect(readHeartbeatRuns(profileDir)[0]?.sweep?.costCents).toBe(7);
    // Delivered down the path a reply takes, and it says who promotes: nothing is promoted here.
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]).toContain("improve promote");
    expect(f.deliveries[0]).toContain("7 of 100 cents");

    // The interval, not the tick, decides the next one.
    clock = new Date("2026-09-15T10:00:00.000Z");
    const second = await f.loop.tick();
    expect(second.sweepSkipped).toBe("interval");
    expect(f.sweeps).toHaveLength(1);

    // A day later it sweeps again, and a fresh loop reads the last sweep off the history.
    clock = new Date("2026-09-16T09:00:00.000Z");
    const later = fake({ config: SWEEPING, reply: NO_REPLY, sweep: { capCents: 100, report: DISTILLED } });
    await later.loop.tick();
    expect(later.sweeps).toHaveLength(1);
  });

  it("names in the history why it did not sweep: disabled, quiet hours, the interval, no headroom", async () => {
    const off = fake({ config: OFFICE, reply: NO_REPLY, sweep: { capCents: 100, report: DISTILLED } });
    expect((await off.loop.tick()).sweepSkipped).toBe("disabled");
    expect(off.sweeps).toEqual([]);

    fs.rmSync(heartbeatRunsPath(profileDir), { force: true });
    clock = new Date("2026-09-15T23:00:00.000Z");
    const quiet = fake({ config: SWEEPING, sweep: { capCents: 100, report: DISTILLED } });
    expect(await quiet.loop.tick()).toMatchObject({ decision: "quiet", sweepSkipped: "quiet_hours" });
    expect(quiet.sweeps).toEqual([]);

    fs.rmSync(heartbeatRunsPath(profileDir), { force: true });
    clock = new Date("2026-09-15T09:00:00.000Z");
    const poor = fake({
      config: SWEEPING,
      reply: NO_REPLY,
      sweep: { capCents: 100, report: DISTILLED, budget: { spentCents: () => 950, limitCents: () => 1000 } },
    });
    expect((await poor.loop.tick()).sweepSkipped).toBe("budget");
    expect(poor.sweeps).toEqual([]);

    // The same ledger with room for the cap lets it through.
    fs.rmSync(heartbeatRunsPath(profileDir), { force: true });
    const rich = fake({
      config: SWEEPING,
      reply: NO_REPLY,
      sweep: { capCents: 100, report: DISTILLED, budget: { spentCents: () => 100, limitCents: () => 1000 } },
    });
    expect((await rich.loop.tick()).sweepSkipped).toBeUndefined();
    expect(rich.sweeps).toHaveLength(1);
  });

  it("sweepNow runs whatever the interval says, never over the cap, and refuses without headroom", async () => {
    const f = fake({ config: OFFICE, sweep: { capCents: 100, report: DISTILLED } });
    const first = await f.loop.sweepNow();
    expect(first).toMatchObject({ ran: true });
    const second = await f.loop.sweepNow();
    expect(second).toMatchObject({ ran: true });
    expect(f.sweeps).toEqual([
      { at: "2026-09-15T09:00:00.000Z", capCents: 100, trigger: "manual" },
      { at: "2026-09-15T09:00:00.000Z", capCents: 100, trigger: "manual" },
    ]);
    // A manual sweep is the founder's own command: it reports back, it does not message them.
    expect(f.deliveries).toEqual([]);
    const rows = readHeartbeatRuns(profileDir);
    expect(rows.map((r) => r.decision)).toEqual(["sweep", "sweep"]);

    const status = heartbeatStatus(profileDir, OFFICE, now());
    expect(status.sweep).toMatchObject({ enabled: false, intervalHours: 24 });
    expect(status.sweep.last).toMatchObject({ costCents: 7, capCents: 100, drafts: 2 });
    // A manual sweep is not a tick: it never moves the next tick.
    expect(status.nextTickAt).toBe(null);

    const poor = fake({ config: OFFICE, sweep: { capCents: 100, report: DISTILLED, budget: { spentCents: () => 1000, limitCents: () => 1000 } } });
    expect(await poor.loop.sweepNow()).toEqual({ ran: false, skipped: "budget" });
    expect(poor.sweeps).toEqual([]);
  });

  it("is off by default in the schema and the shipped defaults, once a day when it is on", () => {
    const parsed = HeartbeatConfigSchema.parse({});
    expect(parsed.sweep.enabled).toBe(false);
    expect(parsed.sweep_interval_hours).toBe(24);
    expect(DEFAULT_CONFIG.heartbeat).toMatchObject({ sweep: { enabled: false }, sweep_interval_hours: 24 });
  });
});
