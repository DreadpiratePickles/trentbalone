/**
 * The profile locks at the command line (packages/trent-core/src/profile/locks.ts).
 *
 * `trent gateway start` refuses when a live gateway already holds this profile, before it builds a
 * runtime, and `trent gateway status` names the holder. The maintenance commands that rewrite or
 * delete profile state (`sessions prune`, `fleet import`, `doctor --fix`, `uninstall`) refuse while
 * another live process is registered as a writer on the profile, exit 3 naming each pid and label,
 * and delete nothing; `--force` goes ahead after one warning line.
 *
 * "Another live process" is a real one: a plain Node sleeper, whose pid the lock file names. This
 * process's own writer registration never blocks a command it runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
import { acquireProfileLock, profileLockPath } from "@trent/core/profile/locks.js";
import { SessionManager } from "@trent/core/sessions/index.js";
import type { DoctorReport } from "@trent/core/doctor/index.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

let home: string;
const children: ChildProcess[] = [];
const releases: Array<() => void> = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-profile-locks-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A live process that is not this one. */
function sleeper(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

/** Registers `pid` the way the lock module writes a holder: a gateway lock or one writer file. */
function holdAs(profileDir: string, role: "gateway" | "writer", pid: number, label: string): void {
  const file = profileLockPath(profileDir, role, pid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid, startedAt: "2026-09-25T08:00:00.000Z", label, hostname: os.hostname() }));
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

function seedSessions(count: number): SessionManager {
  const sessions = new SessionManager(new ConfigManager({ profile: "default" }));
  for (let i = 0; i < count; i += 1) sessions.startSession("ceo", "scripted-model", "scripted");
  return sessions;
}

describe("trent gateway start under a live gateway", () => {
  it("exits 3 naming the holder's pid, and builds no runtime and no manager", async () => {
    const pid = sleeper();
    holdAs(home, "gateway", pid, "gateway");
    const gatewayRuntime = vi.fn();
    const gatewayManager = vi.fn();
    const result = await runCli(["gateway", "start", "--json"], { overrides: { gatewayRuntime, gatewayManager } as unknown as CliOverrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(output(result)).toContain(`pid ${pid}`);
    expect(gatewayRuntime).not.toHaveBeenCalled();
    expect(gatewayManager).not.toHaveBeenCalled();
  });

  it("a gateway that takes the lock after the check still wins: the runtime is released and the command exits 3", async () => {
    const cleanup = vi.fn(async () => undefined);
    const runtime = { orchestrator: { approve: vi.fn(), reject: vi.fn() }, companyId: "cmp", run: vi.fn(), cleanup } as unknown as HeadlessRuntime;
    const overrides: CliOverrides = {
      gatewayRuntime: async () => runtime,
      gatewayManager: (configManager, options) => {
        // The race: another gateway on this profile starts between the probe and our start.
        const rival = acquireProfileLock({ profileDir: configManager.getProfileDir(), role: "gateway", label: "rival" });
        if (rival.ok) releases.push(rival.release);
        return new GatewayManager(configManager, options);
      },
    };
    const result = await runCli(["gateway", "start", "--json"], { overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(output(result)).toContain(`pid ${process.pid}`);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("trent gateway status", () => {
  it("names the live holder of this profile's gateway lock, and gateways on the host's other profiles", async () => {
    const pid = sleeper();
    holdAs(home, "gateway", pid, "gateway");
    const other = sleeper();
    holdAs(new ConfigManager({ profile: "work" }).getProfileDir(), "gateway", other, "gateway");
    const result = await runCli(["gateway", "status", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { gateway: Record<string, unknown>; gateways: Array<Record<string, unknown>> };
    expect(data.gateway).toMatchObject({ running: true, pid, label: "gateway" });
    expect(data.gateways).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "default", pid }),
      expect.objectContaining({ profile: "work", pid: other }),
    ]));
    const human = await runCli(["gateway", "status", "--no-color"]);
    expect(human.stdout).toContain(`pid ${pid}`);
    expect(human.stdout).toContain(`pid ${other}`);
  });

  it("says no gateway is running when the lock is absent or names a dead pid", async () => {
    holdAs(home, "gateway", 2_147_483_646, "gateway");
    const result = await runCli(["gateway", "status", "--json"]);
    expect(JSON.parse(result.stdout)).toMatchObject({ gateway: { running: false }, gateways: [] });
  });
});

describe("maintenance under a live writer", () => {
  it("sessions prune exits 3 naming each writer's pid and label, and deletes nothing", async () => {
    const sessions = seedSessions(3);
    const repl = sleeper();
    const gateway = sleeper();
    holdAs(home, "writer", repl, "repl");
    holdAs(home, "writer", gateway, "gateway");
    const result = await runCli(["sessions", "prune", "--max-count", "1", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(output(result)).toContain(`pid ${repl} (repl)`);
    expect(output(result)).toContain(`pid ${gateway} (gateway)`);
    expect(sessions.listSessions()).toHaveLength(3);
  });

  it("sessions prune --force goes ahead after exactly one warning line", async () => {
    const sessions = seedSessions(3);
    const repl = sleeper();
    holdAs(home, "writer", repl, "repl");
    const result = await runCli(["sessions", "prune", "--max-count", "1", "--force", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ removedCount: 2, kept: 1 });
    const warnings = result.stderr.split("\n").filter((line) => line.startsWith("warning:"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`pid ${repl} (repl)`);
    expect(sessions.listSessions()).toHaveLength(1);
  });

  it("a dead writer's file does not block, and this process's own registration never does", async () => {
    seedSessions(2);
    holdAs(home, "writer", 2_147_483_646, "crashed repl");
    const mine = acquireProfileLock({ profileDir: home, role: "writer", label: "this test" });
    if (mine.ok) releases.push(mine.release);
    const result = await runCli(["sessions", "prune", "--max-count", "1", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ removedCount: 1 });
  });

  it("fleet import refuses before it opens the store or reads the bundle", async () => {
    const pid = sleeper();
    holdAs(home, "writer", pid, "run");
    const result = await runCli(["fleet", "import", path.join(home, "no-such-bundle"), "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(output(result)).toContain(`pid ${pid} (run)`);
    expect(output(result)).toContain("fleet.import");
  });

  it("doctor --fix refuses; the read-only doctor still runs", async () => {
    const pid = sleeper();
    holdAs(home, "writer", pid, "cron");
    const fix = await runCli(["doctor", "--fix", "--json"]);
    expect(fix.exitCode).toBe(EXIT.CONFIG);
    expect(output(fix)).toContain("doctor.fix");
    expect(output(fix)).toContain(`pid ${pid} (cron)`);
    const report: DoctorReport = { results: [], total: 0, passed: 0, warnings: 0, errors: 0, skipped: 0, durationMs: 0 } as unknown as DoctorReport;
    const plain = await runCli(["doctor", "--json"], { overrides: { doctorRunAll: async () => report } });
    expect(plain.exitCode).toBe(EXIT.OK);
  });

  it("uninstall refuses to delete a profile a live process is writing; --force deletes it", async () => {
    const profile = new ConfigManager({ profile: "work" });
    profile.saveConfig(profile.loadConfig());
    const pid = sleeper();
    holdAs(profile.getProfileDir(), "writer", pid, "gateway");
    const refused = await runCli(["uninstall", "--yes", "--profile", "work", "--json"]);
    expect(refused.exitCode).toBe(EXIT.CONFIG);
    expect(output(refused)).toContain(`pid ${pid} (gateway)`);
    expect(fs.existsSync(profile.getProfileDir())).toBe(true);
    // The default profile's directory is the base directory, which holds every named profile.
    const viaDefault = await runCli(["uninstall", "--yes", "--json"]);
    expect(viaDefault.exitCode).toBe(EXIT.CONFIG);
    expect(fs.existsSync(home)).toBe(true);
    const forced = await runCli(["uninstall", "--yes", "--profile", "work", "--force", "--json"]);
    expect(forced.exitCode).toBe(EXIT.OK);
    expect(fs.existsSync(profile.getProfileDir())).toBe(false);
  });
});
