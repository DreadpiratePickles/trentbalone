/**
 * `trent heartbeat start|status|runs`: the CLI face of the heartbeat loop over
 * `<profile>/HEARTBEAT.md`. `start` executes through the headless runtime (a fake here, so no
 * proxy, sandbox or model) and a reply goes to `gateway.owner` through the gateway manager's
 * `send`; `NO_REPLY` sends nothing. `status` and `runs` read `<profile>/heartbeat/runs.jsonl`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { GatewayManager, type OutboundMessage } from "@trent/core/gateway/index.js";
import { NO_REPLY, heartbeatLockPath, readHeartbeatRuns, type HeartbeatRunRow } from "@trent/core/heartbeat/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-heartbeat-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_hb", at: "2026-09-15T09:00:00.000Z", ...extra } as OrcEvent;
}

/** Enables the heartbeat in the scratch profile's config.yaml, with an owner unless told otherwise. */
function configure(extra: Record<string, unknown> = {}, owner = true): void {
  const manager = new ConfigManager({ baseDir: home });
  const config = manager.loadConfig();
  manager.saveConfig({
    ...config,
    heartbeat: { ...config.heartbeat, enabled: true, interval_minutes: 15, active_hours: { start: "08:00", end: "20:00", tz: "UTC" }, ...extra },
    gateway: { ...config.gateway, ...(owner ? { owner: { platform: "telegram", channelId: "555" } } : {}) },
  });
}

/**
 * A stand-in for `process`, as `gateway start` already uses: it records the order of what happened,
 * so a test can say the shutdown finished BEFORE the exit, which is the whole point of owning Ctrl+C.
 */
function fakeSignals(order: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    once(event: string, listener: () => void): unknown {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${String(code)}`);
    },
    handled(event: string): boolean {
      return (listeners.get(event) ?? []).length > 0;
    },
    async raise(event: string): Promise<void> {
      for (const listener of listeners.get(event) ?? []) listener();
      // Give the release its turns; stop as soon as the process would have gone, or after 100.
      for (let i = 0; i < 100 && !order.some((entry) => entry.startsWith("exit:")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

interface Fakes {
  overrides: CliOverrides;
  runs: Array<{ objective: string; trigger: string }>;
  sent: Array<{ platform: string; message: OutboundMessage }>;
  managers: GatewayManager[];
  cleanup: ReturnType<typeof vi.fn>;
  /** What happened, in order: the release steps, then the exit. */
  order: string[];
  /** The `process` the command's signal handling runs against; the worker's own is left alone. */
  signals: ReturnType<typeof fakeSignals>;
}

function fakes(reply = NO_REPLY, at = "2026-09-15T09:00:00.000Z"): Fakes {
  const runs: Fakes["runs"] = [];
  const sent: Fakes["sent"] = [];
  const managers: GatewayManager[] = [];
  const order: string[] = [];
  const signals = fakeSignals(order);
  const cleanup = vi.fn(async () => {
    // A real cleanup awaits the proxy and the sandboxes; the await is what a synchronous exit pre-empts.
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push("cleanup");
    return undefined;
  });
  const runtime = {
    // The id `commands/improve.ts` resolves for a profile that names no company, so the
    // unattended sweep and `trent improve status` speak about the same company.
    companyId: "trent-local",
    store: {},
    run: (objective: string, options: { trigger: string }) => {
      runs.push({ objective, trigger: options.trigger });
      const stream = [ev("run_start"), ev("run_done", { run: { status: "completed", summary: reply } })];
      return (async function* () {
        for (const event of stream) yield event;
      })();
    },
    cleanup,
  } as unknown as HeadlessRuntime;
  return {
    runs,
    sent,
    managers,
    cleanup,
    order,
    signals,
    overrides: {
      // `gateway start`, `heartbeat start` and `cron start` all claim Ctrl+C through this seam;
      // the recorder keeps the worker's own signals alone.
      signals,
      now: () => new Date(at),
      gatewayRuntime: async () => runtime,
      gatewayManager: (configManager, options) => {
        const manager = new GatewayManager(configManager, options);
        vi.spyOn(manager, "send").mockImplementation(async (platform, message) => {
          sent.push({ platform, message });
          return { queued: "q1", sent: true };
        });
        managers.push(manager);
        return manager;
      },
    },
  };
}

describe("trent heartbeat", () => {
  it("start --dry-run --json exits 0 and reports what would run, even when the heartbeat is disabled", async () => {
    const result = await runCli(["heartbeat", "start", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toEqual({ dryRun: true, command: "heartbeat start", enabled: false, intervalMinutes: 60, owner: null });
  });

  it("start --once runs one heartbeat through the runtime with trigger heartbeat; NO_REPLY sends nothing and records no_reply", async () => {
    configure();
    const f = fakes();
    const result = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { once: true; run: HeartbeatRunRow };
    expect(data.run).toMatchObject({ at: "2026-09-15T09:00:00.000Z", decision: "no_reply" });
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]).toMatchObject({ trigger: "heartbeat" });
    expect(f.runs[0]?.objective).toContain("Heartbeat checklist");
    expect(f.runs[0]?.objective).toContain(`answer exactly ${NO_REPLY}`);
    expect(f.sent).toEqual([]);
    expect(f.managers).toHaveLength(0);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(readHeartbeatRuns(home)).toEqual([data.run]);
    expect(fs.existsSync(heartbeatLockPath(home))).toBe(false);
  });

  it("start --once delivers a real reply to gateway.owner through the manager's send", async () => {
    configure();
    const f = fakes("Two approvals have waited since yesterday.");
    const result = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(result.stdout) as { run: HeartbeatRunRow }).run).toMatchObject({ decision: "reply", chars: 42 });
    expect(f.sent).toEqual([{ platform: "telegram", message: { channelId: "555", text: "Two approvals have waited since yesterday.", metadata: { subject: "Trent heartbeat" } } }]);
  });

  it("start --once inside quiet hours makes no model call and records quiet", async () => {
    configure();
    const f = fakes(NO_REPLY, "2026-09-15T23:00:00.000Z");
    const result = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(result.stdout) as { run: HeartbeatRunRow }).run).toMatchObject({ decision: "quiet" });
    expect(f.runs).toEqual([]);
  });

  it("start refuses when heartbeat.enabled is false, and says which key to set", async () => {
    const f = fakes();
    const result = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("heartbeat.enabled");
    expect(f.runs).toEqual([]);
  });

  it("start holds the process, writes the lock with this pid, and ticks on the configured interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      configure();
      const f = fakes();
      const result = await runCli(["heartbeat", "start", "--json"], { overrides: f.overrides });
      expect(result.exitCode).toBe(EXIT.OK);
      expect(result.keepAlive).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({ started: true, pid: process.pid, intervalMinutes: 15, owner: "telegram:555" });
      expect(JSON.parse(fs.readFileSync(heartbeatLockPath(home), "utf8"))).toMatchObject({ pid: process.pid });
      expect(f.runs).toEqual([]);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(f.runs).toHaveLength(1);

      const second = await runCli(["heartbeat", "start", "--json"], { overrides: f.overrides });
      expect(second.exitCode).toBe(EXIT.CONFIG);
      expect(second.stdout).toContain("already running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Ctrl+C is owned by the command: the shutdown releases the lock before exit 130", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      configure();
      const f = fakes();
      const result = await runCli(["heartbeat", "start", "--json"], { overrides: f.overrides });
      expect(result.exitCode).toBe(EXIT.OK);
      expect(result.keepAlive).toBe(true);
      // SIGTERM and SIGHUP already released; Ctrl+C used to reach the binary's global handler,
      // which exits synchronously on top of the release.
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(f.signals.handled(signal)).toBe(true);
      expect(fs.existsSync(heartbeatLockPath(home))).toBe(true);

      await f.signals.raise("SIGINT");
      expect(fs.existsSync(heartbeatLockPath(home))).toBe(false);
      expect(f.cleanup).toHaveBeenCalledTimes(1);
      // The release ran to completion first; only then did the process go.
      expect(f.order).toEqual(["cleanup", `exit:${String(EXIT.INTERRUPT)}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("status --json reports enabled, interval, quiet-now, the last decision and the next tick", async () => {
    const before = await runCli(["heartbeat", "status", "--json"]);
    expect(before.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(before.stdout)).toMatchObject({ enabled: false, intervalMinutes: 60, last: null, nextTickAt: null, running: false });

    configure();
    const f = fakes();
    await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    const after = await runCli(["heartbeat", "status", "--json"], { overrides: f.overrides });
    expect(after.exitCode).toBe(EXIT.OK);
    const status = JSON.parse(after.stdout) as { enabled: boolean; intervalMinutes: number; quietNow: boolean; last: HeartbeatRunRow; nextTickAt: string };
    expect(status).toMatchObject({ enabled: true, intervalMinutes: 15, quietNow: false, nextTickAt: "2026-09-15T09:15:00.000Z" });
    expect(status.last).toMatchObject({ decision: "no_reply" });

    const human = await runCli(["heartbeat", "status", "--no-color"], { overrides: f.overrides });
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("no_reply");
  });

  /**
   * [D2] The unattended sweep. Nothing here reaches a model: the sweep runs offline
   * (`skipLLM`), so the meter reports a real zero and every draft the loop could produce would
   * still be waiting for `trent improve promote`.
   */
  it("sweep --now runs one metered sweep against improve.sweep_cap_cents and records it", async () => {
    configure();
    const f = fakes();
    const result = await runCli(["heartbeat", "sweep", "--now", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { ran: boolean; record: { trigger: string; capCents: number; costCents: number; drafts: number; blocked: string[] } };
    expect(data.ran).toBe(true);
    expect(data.record).toMatchObject({ trigger: "manual", capCents: 100, costCents: 0, drafts: 0 });
    // The seats nobody has run yet are named, so a sweep that produced nothing says why.
    expect(data.record.blocked.join(" ")).toContain("below_threshold");
    // No model call, and the founder is at the terminal, so nothing is messaged.
    expect(f.runs).toEqual([]);
    expect(f.sent).toEqual([]);

    const rows = readHeartbeatRuns(home);
    expect(rows.map((r) => r.decision)).toEqual(["sweep"]);
    const status = JSON.parse((await runCli(["heartbeat", "status", "--json"], { overrides: f.overrides })).stdout) as {
      sweep: { enabled: boolean; intervalHours: number; last: { trigger: string; costCents: number } | null; nextAt: string | null };
      nextTickAt: string | null;
    };
    expect(status.sweep).toMatchObject({ enabled: false, intervalHours: 24 });
    expect(status.sweep.last).toMatchObject({ trigger: "manual", costCents: 0 });
    expect(status.sweep.nextAt).toBe("2026-09-16T09:00:00.000Z");
    // A manual sweep is not a tick.
    expect(status.nextTickAt).toBe(null);

    const human = await runCli(["heartbeat", "status", "--no-color"], { overrides: f.overrides });
    expect(human.stdout).toContain("sweep");
  });

  it("sweep without --now refuses and names the flag, and --dry-run says what it would spend", async () => {
    configure();
    const f = fakes();
    const refused = await runCli(["heartbeat", "sweep", "--json"], { overrides: f.overrides });
    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(refused.stdout).toContain("--now");
    expect(readHeartbeatRuns(home)).toEqual([]);

    const dry = await runCli(["heartbeat", "sweep", "--now", "--dry-run", "--json"], { overrides: f.overrides });
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, command: "heartbeat sweep", capCents: 100 });
    expect(readHeartbeatRuns(home)).toEqual([]);
  });

  it("start --once sweeps when heartbeat.sweep.enabled is on, delivers the report, and says why when it is off", async () => {
    configure({ sweep: { enabled: true } });
    const f = fakes();
    const result = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const run = (JSON.parse(result.stdout) as { run: HeartbeatRunRow }).run;
    expect(run).toMatchObject({ decision: "no_reply" });
    expect(run.sweep).toMatchObject({ trigger: "heartbeat", capCents: 100, costCents: 0 });
    expect(run.sweepSkipped).toBeUndefined();
    // The report goes down the path a reply takes: the same manager, the same owner.
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.message.text).toContain("improve promote");

    fs.rmSync(path.join(home, "heartbeat", "runs.jsonl"), { force: true });
    configure({ sweep: { enabled: false } });
    const off = fakes();
    const second = await runCli(["heartbeat", "start", "--once", "--json"], { overrides: off.overrides });
    expect((JSON.parse(second.stdout) as { run: HeartbeatRunRow }).run.sweepSkipped).toBe("disabled");
    expect(off.sent).toEqual([]);
  });

  it("runs --json lists the rows newest last and --last N trims them", async () => {
    configure();
    const empty = await runCli(["heartbeat", "runs", "--json"]);
    expect(empty.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(empty.stdout)).toEqual({ runs: [] });

    for (const at of ["2026-09-15T09:00:00.000Z", "2026-09-15T09:15:00.000Z", "2026-09-15T09:30:00.000Z"]) {
      await runCli(["heartbeat", "start", "--once", "--json"], { overrides: fakes(NO_REPLY, at).overrides });
    }
    const all = await runCli(["heartbeat", "runs", "--json"]);
    const rows = (JSON.parse(all.stdout) as { runs: HeartbeatRunRow[] }).runs;
    expect(rows.map((r) => r.at)).toEqual(["2026-09-15T09:00:00.000Z", "2026-09-15T09:15:00.000Z", "2026-09-15T09:30:00.000Z"]);

    const last = await runCli(["heartbeat", "runs", "--last", "2", "--json"]);
    expect((JSON.parse(last.stdout) as { runs: HeartbeatRunRow[] }).runs).toEqual(rows.slice(1));

    const bad = await runCli(["heartbeat", "runs", "--last", "0", "--json"]);
    expect(bad.exitCode).toBe(EXIT.CONFIG);

    const human = await runCli(["heartbeat", "runs", "--no-color"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("no_reply");
  });
});

/**
 * [D2.1] The unattended sweep builds itself the way `trent improve sweep` does: the profile's
 * improve store, the same cap, and the SEAT SUITES — a seat's promoted goldens plus its mechanical
 * overlays. Before this, the heartbeat bound `runImprovementSweep` with no `suiteFor`, so every
 * draft it produced was blocked `no_suite` however many goldens a human had promoted.
 *
 * Offline throughout: `live: false`, so no model is reached and `no_gateway` is the honest next
 * refusal for a seat that now HAS a suite.
 */
describe("[D2.1] the heartbeat sweep gates against the same seat suites as improve sweep", () => {
  let store: InMemoryImproveStore;

  beforeEach(() => {
    store = new InMemoryImproveStore();
    setImproveStoreForTests(store);
  });

  afterEach(() => {
    setImproveStoreForTests(undefined);
  });

  async function seedTraces(agentId: string, runId: string): Promise<void> {
    for (const id of ["a", "b", "c"]) {
      await store.appendTrace({
        id: `${agentId}_${id}`,
        companyId: "trent-local",
        agentRole: agentId,
        agentId,
        runId,
        taskType: "ship-feature",
        stepTitle: "implement",
        status: "completed",
        toolCalls: ["GitHub", "memory:read"],
        toolCallCount: 2,
        critiqueVerdict: id === "b" ? "retry" : "pass",
        improvement: null,
        evalScore: 0.9,
        costCents: 1,
        latencyMs: 10,
        humanCorrected: false,
        skillApplied: false,
        createdAt: "2026-09-12T10:00:00.000Z",
      });
    }
  }

  /** A captured failure golden on `runId`, exactly as the orchestrator writes it (quarantined). */
  function capture(index: number, runId: string): string {
    const dir = path.join(home, "goldens");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `golden-${runId}-${String(index)}.json`),
      JSON.stringify({
        id: `orcgolden_${String(index)}`,
        companyId: "trent-local",
        runId,
        objective: `Ship the ${String(index)}th release note and verify the totals`,
        reason: "run_failed: the engineer step never verified the build",
        status: "quarantined",
        trajectoryFailureTags: ["trajectory_terminal_event_emitted"],
        capturedAt: "2026-09-18T10:00:00.000Z",
      }),
      "utf8",
    );
    return `orcgolden_${String(index)}`;
  }

  async function quarantineGates(): Promise<Map<string, string | null>> {
    const status = await runCli(["improve", "status", "--json"]);
    expect(status.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(status.stdout) as { quarantine: Array<{ agentId: string; gate: { blockedBy: string | null } | null }> };
    return new Map(data.quarantine.map((q) => [q.agentId, q.gate?.blockedBy ?? null]));
  }

  it("sweep --now gates a seat whose golden a human promoted, and names the seat that has none", async () => {
    configure();
    await seedTraces("engineer", "run_1");
    await seedTraces("finance", "run_2");
    const promoted = capture(1, "run_1");
    capture(2, "run_2");
    expect((await runCli(["improve", "goldens", "promote", promoted, "--json"])).exitCode).toBe(EXIT.OK);

    const f = fakes();
    const swept = await runCli(["heartbeat", "sweep", "--now", "--json"], { overrides: f.overrides });
    expect(swept.exitCode).toBe(EXIT.OK);
    const record = (JSON.parse(swept.stdout) as { ran: boolean; record: { capCents: number; costCents: number; drafts: number } }).record;
    // The same cap as `trent improve sweep`, and offline it still costs a real zero.
    expect(record).toMatchObject({ capCents: 100, costCents: 0 });
    expect(record.drafts).toBeGreaterThanOrEqual(2);

    const gates = await quarantineGates();
    // The promoted golden IS the engineer's suite, so the gate stops answering no_suite.
    expect(gates.get("engineer"), "the unattended sweep drafted for the seat with a golden").toBeDefined();
    expect(gates.get("engineer")).not.toContain("no_suite");
    expect(gates.get("engineer")).toBe("no_gateway");
    // The seat with nothing promoted is refused by name, with both counts.
    const finance = gates.get("finance") ?? "";
    expect(finance).toContain("no_suite");
    expect(finance).toContain("finance");
    expect(finance).toContain("0 promoted");
    expect(finance).toContain("1 quarantined");
  });
});

describe("trent gateway start with the heartbeat enabled", () => {
  it("starts the loop alongside the listeners, reports it, and ticks through the same runtime", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      configure();
      const f = fakes("Two approvals have waited since yesterday.");
      const gateway = f.overrides.gatewayManager!;
      f.overrides.gatewayManager = (cm, options) => {
        const manager = gateway(cm, options);
        vi.spyOn(manager, "startAllConfigured").mockImplementation(async () => ["telegram"]);
        return manager;
      };
      const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
      expect(result.exitCode).toBe(EXIT.OK);
      expect(JSON.parse(result.stdout)).toMatchObject({ started: ["telegram"], heartbeat: true });
      expect(JSON.parse(fs.readFileSync(heartbeatLockPath(home), "utf8"))).toMatchObject({ pid: process.pid });
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(f.runs).toHaveLength(1);
      expect(f.runs[0]).toMatchObject({ trigger: "heartbeat" });
      expect(f.sent).toEqual([{ platform: "telegram", message: { channelId: "555", text: "Two approvals have waited since yesterday.", metadata: { subject: "Trent heartbeat" } } }]);
      // One manager serves the listeners and the heartbeat's deliveries.
      expect(f.managers).toHaveLength(1);
      await f.managers[0]?.stopAll();
    } finally {
      vi.useRealTimers();
      for (const signal of ["SIGTERM", "SIGHUP"] as const) process.removeAllListeners(signal);
    }
  });

  it("with the heartbeat disabled gateway start reports heartbeat false and takes no lock", async () => {
    const f = fakes();
    const result = await runCli(["gateway", "start", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ heartbeat: false });
    expect(fs.existsSync(heartbeatLockPath(home))).toBe(false);
  });
});
