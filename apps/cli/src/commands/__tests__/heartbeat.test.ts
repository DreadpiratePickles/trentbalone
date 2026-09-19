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
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import { runCli } from "../index.js";

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
    companyId: "cmp_local",
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
