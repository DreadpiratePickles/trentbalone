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
import type { HeartbeatConfig } from "../config/schema.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { HEARTBEAT_MD, NO_REPLY, DEFAULT_HEARTBEAT_MD, HeartbeatLoop, heartbeatLockPath, heartbeatRunsPath, heartbeatStatus, readHeartbeatRuns, type HeartbeatRunRow } from "./HeartbeatLoop.js";

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

const OFFICE: HeartbeatConfig = { enabled: true, interval_minutes: 60, active_hours: { start: "08:00", end: "20:00", tz: "UTC" }, consolidate_memory: true };

interface Fake {
  loop: HeartbeatLoop;
  launches: Array<{ objective: string; trigger: string }>;
  deliveries: string[];
  consolidations: string[];
  logs: string[];
}

function fake(opts: { config?: HeartbeatConfig; reply?: string; events?: OrcEvent[]; throwOnRun?: Error; owner?: false; historyLimit?: number } = {}): Fake {
  const launches: Fake["launches"] = [];
  const deliveries: string[] = [];
  const consolidations: string[] = [];
  const logs: string[] = [];
  const loop = new HeartbeatLoop({
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
  return { loop, launches, deliveries, consolidations, logs };
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
