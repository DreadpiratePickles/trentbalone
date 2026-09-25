/**
 * `trent service daemon|install|uninstall|status`.
 *
 * `daemon` runs the gateway (when `gateway.enabled`), the cron runner and the heartbeat loop (when
 * `heartbeat.enabled`) in ONE process on ONE headless runtime, the way `gateway start` already
 * carries the heartbeat. It is driven through `runCli` with a fake runtime (no proxy, sandbox or
 * model), the real GatewayManager with one adapter's start/stop stubbed, the real CronRunner and
 * HeartbeatLoop, the real profile locks, and a stand-in `process` for the signals, exactly as
 * gateway-start.test.ts and heartbeat.test.ts do.
 *
 * `install|uninstall|status` run against a scratch home through `setServiceHostForTests`: no
 * launchctl or systemctl is ever executed, and nothing is written outside the scratch directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { cronRunnerLockPath } from "@trent/core/cron/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
import { HeartbeatLoop, heartbeatLockPath } from "@trent/core/heartbeat/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { liveGatewayHolder, liveWriters, profileLockPath } from "@trent/core/profile/locks.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";
import { runCli } from "../index.js";
import { setServiceHostForTests } from "../groups/service.js";

let scratch: string;
let trentHome: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-service-"));
  trentHome = path.join(scratch, ".trent");
  process.env.TRENT_HOME = trentHome;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setServiceHostForTests(undefined);
  for (const child of children.splice(0)) child.kill("SIGKILL");
  delete process.env.TRENT_HOME;
  fs.rmSync(scratch, { recursive: true, force: true });
});

function configure(options: { gateway: boolean; heartbeat: boolean }): void {
  const manager = new ConfigManager({ profile: "default" });
  const config = manager.loadConfig();
  manager.saveConfig({
    ...config,
    gateway: { ...config.gateway, enabled: options.gateway, owner: { platform: "telegram", channelId: "555" } },
    // Inside active hours at the fixed clock (09:00 UTC), so no tick consolidates memory: that path
    // builds a model gateway, and this suite never reaches for a model.
    heartbeat: { ...config.heartbeat, enabled: options.heartbeat, interval_minutes: 15, active_hours: { start: "08:00", end: "20:00", tz: "UTC" } },
  });
}

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_svc", at: "2026-09-25T09:00:00.000Z", ...extra } as OrcEvent;
}

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
      for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

interface Fakes {
  overrides: CliOverrides;
  order: string[];
  signals: ReturnType<typeof fakeSignals>;
  runtimeDeps: HeadlessRuntimeDeps[];
  managers: GatewayManager[];
  runs: Array<{ objective: string; surface?: string }>;
  cleanup: ReturnType<typeof vi.fn>;
}

/** `listening`: the platforms whose adapter reports configured and starts; none means nothing listens. */
function fakes(listening: readonly string[] = ["telegram"]): Fakes {
  const order: string[] = [];
  const signals = fakeSignals(order);
  const runtimeDeps: HeadlessRuntimeDeps[] = [];
  const managers: GatewayManager[] = [];
  const runs: Fakes["runs"] = [];
  const cleanup = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    order.push("cleanup");
  });
  const runtime = {
    orchestrator: { approve: vi.fn(async () => true), reject: vi.fn(async () => true) },
    companyId: "trent-local",
    store: {},
    run: (objective: string, options: { surface?: string } = {}) => {
      runs.push({ objective, ...(options.surface === undefined ? {} : { surface: options.surface }) });
      return (async function* () {
        yield ev("run_start");
        yield ev("run_done", { run: { status: "completed", summary: "NO_REPLY" } });
      })();
    },
    cleanup,
  } as unknown as HeadlessRuntime;
  return {
    order,
    signals,
    runtimeDeps,
    managers,
    runs,
    cleanup,
    overrides: {
      signals,
      now: () => new Date("2026-09-25T09:00:00.000Z"),
      gatewayRuntime: async (deps) => {
        runtimeDeps.push(deps);
        return runtime;
      },
      gatewayManager: (configManager, options) => {
        const manager = new GatewayManager(configManager, options);
        for (const id of listening) {
          const adapter = manager.getAdapter(id)!;
          vi.spyOn(adapter, "isConfigured").mockReturnValue(true);
          vi.spyOn(adapter, "start").mockResolvedValue(undefined);
          vi.spyOn(adapter, "stop").mockResolvedValue(undefined);
        }
        managers.push(manager);
        return manager;
      },
    },
  };
}

function serviceLog(): string[] {
  const file = path.join(trentHome, "logs", "service.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trimEnd().split("\n").map((line) => line.replace(/^\S+ service\[\d+\] /, "")) : [];
}

function mine(): ReturnType<typeof liveWriters> {
  return liveWriters(trentHome).filter((writer) => writer.pid === process.pid);
}

describe("trent service daemon", () => {
  it("starts the gateway, the cron runner and the heartbeat on one runtime, holding each lock once", async () => {
    configure({ gateway: true, heartbeat: true });
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      pid: process.pid,
      profile: "default",
      components: [
        { name: "gateway", state: "started", detail: "telegram" },
        { name: "cron", state: "started" },
        { name: "heartbeat", state: "started" },
      ],
      log: path.join(trentHome, "logs", "service.log"),
    });
    // One runtime and one manager serve all three.
    expect(f.runtimeDeps).toHaveLength(1);
    expect(f.runtimeDeps[0]?.surface).toBe("gateway");
    expect(f.managers).toHaveLength(1);
    // The profile's gateway lock names this process; this process is ONE writer, whatever it runs.
    expect(liveGatewayHolder(trentHome)).toMatchObject({ pid: process.pid, label: "gateway" });
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.label.split("+").sort()).toEqual(["cron", "gateway", "service"]);
    expect(fs.existsSync(cronRunnerLockPath(trentHome))).toBe(true);
    expect(fs.existsSync(heartbeatLockPath(trentHome))).toBe(true);
    expect(serviceLog()).toEqual(["service starting: profile default", "gateway started: telegram", "cron started", "heartbeat started"]);
    expect(result.stderr).toContain("gateway started: telegram");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(f.signals.handled(signal)).toBe(true);

    // The heartbeat ticks through the shared runtime and names itself on the ledger.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(f.runs.some((run) => run.surface === "heartbeat")).toBe(true);

    await f.signals.raise("SIGTERM");
  });

  it("SIGTERM stops heartbeat, cron and gateway in that order, releases every lock, then exits 130", async () => {
    configure({ gateway: true, heartbeat: true });
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.cleanup).not.toHaveBeenCalled();

    await f.signals.raise("SIGTERM");
    expect(serviceLog().slice(-4)).toEqual(["heartbeat stopped", "cron stopped", "gateway stopped", "service stopped"]);
    expect(f.order).toEqual(["cleanup", `exit:${String(EXIT.INTERRUPT)}`]);
    expect(liveGatewayHolder(trentHome)).toBeNull();
    expect(fs.existsSync(profileLockPath(trentHome, "gateway"))).toBe(false);
    expect(mine()).toEqual([]);
    expect(fs.existsSync(cronRunnerLockPath(trentHome))).toBe(false);
    expect(fs.existsSync(heartbeatLockPath(trentHome))).toBe(false);
  });

  it("a runtime cleanup that throws still releases the writer registration and still exits 130", async () => {
    configure({ gateway: true, heartbeat: false });
    const f = fakes();
    f.cleanup.mockImplementation(async () => {
      f.order.push("cleanup");
      throw new Error("the egress proxy would not close");
    });
    expect((await runCli(["service", "daemon", "--json"], { overrides: f.overrides })).exitCode).toBe(EXIT.OK);
    await f.signals.raise("SIGTERM");
    expect(f.order).toEqual(["cleanup", `exit:${String(EXIT.INTERRUPT)}`]);
    expect(liveGatewayHolder(trentHome)).toBeNull();
    expect(mine()).toEqual([]);
    expect(serviceLog().at(-1)).toBe("service stopped");
  });

  it("a second daemon on the same profile is refused before it builds anything, and the first keeps its locks", async () => {
    configure({ gateway: true, heartbeat: true });
    const first = fakes();
    expect((await runCli(["service", "daemon", "--json"], { overrides: first.overrides })).exitCode).toBe(EXIT.OK);
    const second = fakes();
    const refused = await runCli(["service", "daemon", "--json"], { overrides: second.overrides });
    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(refused.stdout).toContain("already running");
    expect(second.runtimeDeps).toHaveLength(0);
    expect(liveGatewayHolder(trentHome)).toMatchObject({ pid: process.pid });
    expect(mine()).toHaveLength(1);
    await first.signals.raise("SIGINT");
    expect(mine()).toEqual([]);
  });

  it("with the gateway and the heartbeat off it runs the cron runner alone and takes no gateway lock", async () => {
    configure({ gateway: false, heartbeat: false });
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({
      components: [
        { name: "gateway", state: "skipped", detail: "gateway.enabled is false" },
        { name: "cron", state: "started" },
        { name: "heartbeat", state: "skipped", detail: "heartbeat.enabled is false" },
      ],
    });
    expect(f.runtimeDeps[0]?.surface).toBe("service");
    expect(f.managers).toHaveLength(0);
    expect(liveGatewayHolder(trentHome)).toBeNull();
    expect(mine()[0]!.label.split("+").sort()).toEqual(["cron", "service"]);
    await f.signals.raise("SIGINT");
    expect(mine()).toEqual([]);
    expect(f.order.at(-1)).toBe(`exit:${String(EXIT.INTERRUPT)}`);
  });

  it("the gateway enabled with no platform listening is a start failure: exit 3, runtime released, no lock left", async () => {
    configure({ gateway: true, heartbeat: true });
    const f = fakes([]);
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("no messaging platform");
    expect(result.keepAlive).toBe(false);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(liveGatewayHolder(trentHome)).toBeNull();
    expect(mine()).toEqual([]);
    expect(serviceLog()).toContain("service stopped");
    expect(serviceLog().some((line) => line.startsWith("gateway failed to start:"))).toBe(true);
  });

  it("a component that fails later in the order stops the started ones in reverse and exits non-zero", async () => {
    configure({ gateway: true, heartbeat: true });
    vi.spyOn(HeartbeatLoop.prototype, "start").mockImplementation(() => {
      throw new Error("the heartbeat could not read HEARTBEAT.md");
    });
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).not.toBe(EXIT.OK);
    expect(result.keepAlive).toBe(false);
    expect(serviceLog()).toEqual([
      "service starting: profile default",
      "gateway started: telegram",
      "cron started",
      "heartbeat failed to start: the heartbeat could not read HEARTBEAT.md",
      "cron stopped",
      "gateway stopped",
      "service stopped",
    ]);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(liveGatewayHolder(trentHome)).toBeNull();
    expect(fs.existsSync(cronRunnerLockPath(trentHome))).toBe(false);
    expect(mine()).toEqual([]);
  });

  it("refuses under a live gateway in another process, naming its pid, before a runtime exists", async () => {
    configure({ gateway: true, heartbeat: false });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    const file = profileLockPath(trentHome, "gateway");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, startedAt: "2026-09-25T08:00:00.000Z", label: "gateway", hostname: os.hostname() }));
    const f = fakes();
    const result = await runCli(["service", "daemon", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain(`pid ${String(child.pid)}`);
    expect(f.runtimeDeps).toHaveLength(0);
  });

  it("--dry-run builds nothing and reports the plan", async () => {
    configure({ gateway: false, heartbeat: true });
    const f = fakes();
    const result = await runCli(["service", "daemon", "--dry-run", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toEqual({
      dryRun: true,
      command: "service daemon",
      profile: "default",
      components: [
        { name: "gateway", state: "skipped", detail: "gateway.enabled is false" },
        { name: "cron", state: "would-start" },
        { name: "heartbeat", state: "would-start" },
      ],
    });
    expect(f.runtimeDeps).toHaveLength(0);
    expect(fs.existsSync(path.join(trentHome, "logs", "service.log"))).toBe(false);
  });
});

describe("trent service install|status|uninstall", () => {
  let calls: Array<{ command: string; args: readonly string[] }>;

  function useHost(platform: NodeJS.Platform): void {
    calls = [];
    setServiceHostForTests({
      platform,
      homeDir: scratch,
      uid: 501,
      exec: (command, args) => {
        calls.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
      processView: { execPath: "/usr/local/bin/node", argv: ["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "install"], execArgv: [] },
      realpath: (p) => p,
      cwd: path.join(scratch, "work"),
      pathEnv: "/usr/local/bin:/usr/bin:/bin",
    });
  }

  it("macOS: install writes the plist in the scratch home and prints the bootstrap line; status sees it; uninstall removes it", async () => {
    useHost("darwin");
    const unitPath = path.join(scratch, "Library", "LaunchAgents", "uk.let-trent.default.plist");
    const installed = await runCli(["service", "install", "--json"]);
    expect(installed.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      manager: "launchd",
      label: "uk.let-trent.default",
      unitPath,
      state: "written",
      programArguments: ["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "daemon", "--profile", "default", "--no-color"],
      workingDirectory: path.join(scratch, "work"),
      next: [`launchctl bootstrap gui/501 ${unitPath}`],
      ran: [],
    });
    const plist = fs.readFileSync(unitPath, "utf8");
    expect(plist).toContain(`<string>${trentHome}</string>`);
    expect(plist).toContain(`<string>${path.join(trentHome, "logs", "service.stderr.log")}</string>`);

    const human = await runCli(["service", "install", "--no-color"]);
    expect(human.stdout).toContain("unchanged");
    expect(human.stdout).toContain(`launchctl bootstrap gui/501 ${unitPath}`);

    const status = await runCli(["service", "status", "--json"]);
    expect(status.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(status.stdout)).toMatchObject({ supported: true, installed: true, unitPath, gateway: { held: false }, daemon: { running: false }, lastLog: [] });

    const removed = await runCli(["service", "uninstall", "--json"]);
    expect(removed.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(removed.stdout)).toMatchObject({ state: "removed", next: ["launchctl bootout gui/501/uk.let-trent.default"] });
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("install refuses to overwrite a different file without --force, and --workdir sets the working directory", async () => {
    useHost("darwin");
    expect((await runCli(["service", "install", "--json"])).exitCode).toBe(EXIT.OK);
    const refused = await runCli(["service", "install", "--workdir", path.join(scratch, "elsewhere"), "--json"]);
    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(refused.stdout).toContain("--force");
    const forced = await runCli(["service", "install", "--workdir", path.join(scratch, "elsewhere"), "--force", "--json"]);
    expect(JSON.parse(forced.stdout)).toMatchObject({ state: "replaced", workingDirectory: path.join(scratch, "elsewhere") });
  });

  it("Linux: prints daemon-reload and enable --now, and runs them only with --now", async () => {
    useHost("linux");
    const printed = await runCli(["service", "install", "--profile", "work", "--json"]);
    expect(printed.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(printed.stdout)).toMatchObject({
      unitPath: path.join(scratch, ".config", "systemd", "user", "trent-work.service"),
      next: ["systemctl --user daemon-reload", "systemctl --user enable --now trent-work.service"],
    });
    expect(calls).toEqual([]);
    const now = await runCli(["service", "install", "--profile", "work", "--now", "--json"]);
    expect(now.exitCode).toBe(EXIT.OK);
    expect(calls.map((c) => [c.command, ...c.args].join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now trent-work.service"]);
  });

  it("status reports the daemon's pid and the last five lines of the service log", async () => {
    useHost("darwin");
    configure({ gateway: false, heartbeat: false });
    const f = fakes();
    expect((await runCli(["service", "daemon", "--json"], { overrides: f.overrides })).exitCode).toBe(EXIT.OK);
    const status = JSON.parse((await runCli(["service", "status", "--json"])).stdout) as { daemon: { running: boolean; pid: number }; lastLog: string[] };
    expect(status.daemon).toMatchObject({ running: true, pid: process.pid });
    expect(status.lastLog.map((line) => line.replace(/^\S+ service\[\d+\] /, ""))).toEqual(["service starting: profile default", "gateway skipped: gateway.enabled is false", "cron started", "heartbeat skipped: heartbeat.enabled is false"]);
    const human = await runCli(["service", "status", "--no-color"]);
    expect(human.stdout).toContain(`pid ${String(process.pid)}`);
    await f.signals.raise("SIGTERM");
  });

  it("Windows: install prints the unsupported message and the manual alternative, and exits 3", async () => {
    useHost("win32");
    const result = await runCli(["service", "install", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    const data = JSON.parse(result.stdout) as { supported: boolean; message: string; alternative: string };
    expect(data.supported).toBe(false);
    expect(data.alternative).toContain("schtasks /Create");
    expect(data.alternative).toContain("service daemon --profile default");
  });

  it("--dry-run install writes nothing and shows the file it would write", async () => {
    useHost("darwin");
    const result = await runCli(["service", "install", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { state: string; content: string; unitPath: string };
    expect(data.state).toBe("would-write");
    expect(data.content).toContain("<key>KeepAlive</key>");
    expect(fs.existsSync(data.unitPath)).toBe(false);
  });
});
