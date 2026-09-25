/**
 * `installService`, `uninstallService` and `readServiceStatus` against a scratch home directory.
 * Every path the functions touch comes from the injected host, so nothing here reads or writes
 * the real ~/Library/LaunchAgents or ~/.config/systemd/user, and `exec` is a recorder: no
 * launchctl or systemctl ever runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import { acquireProfileLock, acquireProfileWriter } from "../profile/locks.js";
import { installService, readServiceStatus, serviceTarget, uninstallService, unsupportedService, type ServiceHost, type ServiceInstallOptions } from "./install.js";
import { serviceLogPaths } from "./service-log.js";
import { renderLaunchdPlist } from "./units.js";

let home: string;
let profileDir: string;
let calls: Array<{ command: string; args: readonly string[] }>;
const releases: Array<() => void> = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-service-install-"));
  profileDir = path.join(home, ".trent");
  calls = [];
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
});

function host(platform: NodeJS.Platform, extra: Partial<ServiceHost> = {}, code = 0): ServiceHost {
  return {
    platform,
    homeDir: home,
    uid: 501,
    exec: (command, args) => {
      calls.push({ command, args });
      return { code, stdout: "", stderr: code === 0 ? "" : "Bootstrap failed: 5: Input/output error" };
    },
    ...extra,
  };
}

function options(platform: NodeJS.Platform, extra: Partial<ServiceInstallOptions> = {}): ServiceInstallOptions {
  return {
    host: host(platform),
    profile: "default",
    profileDir,
    trentHome: profileDir,
    program: ["/usr/local/bin/node", "/opt/trent/dist/index.js"],
    workingDirectory: path.join(home, "work"),
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
    ...extra,
  };
}

function refusal(fn: () => unknown): TrentError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TrentError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("serviceTarget", () => {
  it("macOS: a user agent under <home>/Library/LaunchAgents, labelled uk.let-trent.<profile>", () => {
    expect(serviceTarget(host("darwin"), "work")).toEqual({
      supported: true,
      manager: "launchd",
      label: "uk.let-trent.work",
      unitPath: path.join(home, "Library", "LaunchAgents", "uk.let-trent.work.plist"),
    });
  });

  it("Linux: a user unit under $XDG_CONFIG_HOME/systemd/user, else <home>/.config/systemd/user", () => {
    expect(serviceTarget(host("linux"), "work")).toMatchObject({ manager: "systemd", label: "trent-work.service", unitPath: path.join(home, ".config", "systemd", "user", "trent-work.service") });
    const xdg = path.join(home, "xdg");
    expect(serviceTarget(host("linux", { xdgConfigHome: xdg }), "work")).toMatchObject({ unitPath: path.join(xdg, "systemd", "user", "trent-work.service") });
  });

  it("an explicit unit directory wins over the home-derived one", () => {
    const dir = path.join(home, "agents");
    expect(serviceTarget(host("darwin", { launchAgentsDir: dir }), "default")).toMatchObject({ unitPath: path.join(dir, "uk.let-trent.default.plist") });
    expect(serviceTarget(host("linux", { systemdUserDir: dir }), "default")).toMatchObject({ unitPath: path.join(dir, "trent-default.service") });
  });

  it("Windows is unsupported, with the manual alternative spelled out", () => {
    expect(serviceTarget(host("win32"), "default")).toEqual({ supported: false, platform: "win32" });
    const text = unsupportedService("win32", ["C:\\trent\\trent.exe"], "default");
    expect(text.message).toContain("not supported on win32");
    expect(text.alternative).toBe('schtasks /Create /TN "Trent default" /SC ONLOGON /TR "\\"C:\\trent\\trent.exe\\" service daemon --profile default"');
  });
});

describe("installService on macOS", () => {
  it("writes the plist 0644 under the scratch home, creates the logs directory, and prints the bootstrap line without running it", () => {
    const result = installService(options("darwin"));
    const unitPath = path.join(home, "Library", "LaunchAgents", "uk.let-trent.default.plist");
    expect(result).toMatchObject({ manager: "launchd", label: "uk.let-trent.default", unitPath, state: "written", ran: [] });
    expect(result.next).toEqual([`launchctl bootstrap gui/501 ${unitPath}`]);
    expect(result.programArguments).toEqual(["/usr/local/bin/node", "/opt/trent/dist/index.js", "service", "daemon", "--profile", "default", "--no-color"]);
    expect(result.logs).toEqual({ service: serviceLogPaths(profileDir).service, stdout: serviceLogPaths(profileDir).stdout, stderr: serviceLogPaths(profileDir).stderr });
    expect(fs.readFileSync(unitPath, "utf8")).toBe(result.content);
    expect(fs.statSync(unitPath).mode & 0o777).toBe(0o644);
    expect(fs.statSync(serviceLogPaths(profileDir).dir).isDirectory()).toBe(true);
    expect(result.content).toBe(
      renderLaunchdPlist({
        profile: "default",
        programArguments: result.programArguments,
        workingDirectory: path.join(home, "work"),
        environment: { PATH: "/usr/local/bin:/usr/bin:/bin", TRENT_HOME: profileDir, TRENT_PROFILE: "default", TRENT_QUEUE_FALLBACK: "disabled" },
        stdoutPath: serviceLogPaths(profileDir).stdout,
        stderrPath: serviceLogPaths(profileDir).stderr,
      }),
    );
    expect(calls).toEqual([]);
  });

  it("the same file again is unchanged; a different file is refused without --force and replaced with it", () => {
    installService(options("darwin"));
    expect(installService(options("darwin")).state).toBe("unchanged");

    const moved = options("darwin", { program: ["/opt/other/trent"] });
    const refused = refusal(() => installService(moved));
    expect(refused.code).toBe(EXIT.CONFIG);
    expect(refused.message).toContain("--force");
    const target = serviceTarget(host("darwin"), "default");
    if (!target.supported) throw new Error("darwin is supported");
    expect(fs.readFileSync(target.unitPath, "utf8")).toContain("/opt/trent/dist/index.js");

    const replaced = installService({ ...moved, force: true });
    expect(replaced.state).toBe("replaced");
    // A loaded agent keeps its old argv until it is booted out and bootstrapped again.
    expect(replaced.next).toEqual([`launchctl bootout gui/501/uk.let-trent.default`, `launchctl bootstrap gui/501 ${replaced.unitPath}`]);
    expect(fs.readFileSync(replaced.unitPath, "utf8")).toContain("/opt/other/trent");
  });

  it("--now runs the bootstrap through the injected exec and reports its exit code", () => {
    const result = installService(options("darwin", { now: true }));
    expect(calls).toEqual([{ command: "launchctl", args: ["bootstrap", "gui/501", result.unitPath] }]);
    expect(result.ran).toEqual([{ command: `launchctl bootstrap gui/501 ${result.unitPath}`, code: 0 }]);
  });

  it("--now reports a failing bootstrap with its stderr", () => {
    const result = installService(options("darwin", { now: true, host: host("darwin", {}, 5) }));
    expect(result.ran).toEqual([{ command: `launchctl bootstrap gui/501 ${result.unitPath}`, code: 5, stderr: "Bootstrap failed: 5: Input/output error" }]);
  });

  it("--dry-run renders and writes nothing", () => {
    const result = installService(options("darwin", { dryRun: true, now: true }));
    expect(result.state).toBe("would-write");
    expect(fs.existsSync(result.unitPath)).toBe(false);
    expect(fs.existsSync(serviceLogPaths(profileDir).dir)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("quotes a unit path with a space in the printed command", () => {
    const dir = path.join(home, "Launch Agents");
    const result = installService(options("darwin", { host: host("darwin", { launchAgentsDir: dir }) }));
    expect(result.next).toEqual([`launchctl bootstrap gui/501 '${path.join(dir, "uk.let-trent.default.plist")}'`]);
  });

  it("refuses a profile name that cannot be a label", () => {
    expect(refusal(() => installService(options("darwin", { profile: "../x" }))).code).toBe(EXIT.CONFIG);
  });

  it("refuses on Windows, naming the alternative", () => {
    const refused = refusal(() => installService(options("win32")));
    expect(refused.code).toBe(EXIT.CONFIG);
    expect(refused.message).toContain("schtasks");
  });
});

describe("installService on Linux", () => {
  it("writes the user unit and prints daemon-reload and enable --now without running them", () => {
    const result = installService(options("linux", { profile: "work" }));
    expect(result.unitPath).toBe(path.join(home, ".config", "systemd", "user", "trent-work.service"));
    expect(result.next).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now trent-work.service"]);
    expect(fs.readFileSync(result.unitPath, "utf8")).toContain("WantedBy=default.target");
    expect(calls).toEqual([]);
  });

  it("--now runs daemon-reload then enable --now", () => {
    installService(options("linux", { now: true }));
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", "trent-default.service"] },
    ]);
  });
});

describe("uninstallService", () => {
  it("macOS: removes the plist and prints the bootout line", () => {
    const installed = installService(options("darwin"));
    const result = uninstallService({ host: host("darwin"), profile: "default" });
    expect(result).toEqual({ manager: "launchd", label: "uk.let-trent.default", unitPath: installed.unitPath, state: "removed", next: ["launchctl bootout gui/501/uk.let-trent.default"], ran: [] });
    expect(fs.existsSync(installed.unitPath)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("with nothing installed it reports absent and removes nothing", () => {
    expect(uninstallService({ host: host("darwin"), profile: "default" }).state).toBe("absent");
  });

  it("--now boots the agent out before the file goes; a bootout of an agent that is not loaded is not a failure", () => {
    installService(options("darwin"));
    const result = uninstallService({ host: host("darwin", {}, 3), profile: "default", now: true });
    expect(calls).toEqual([{ command: "launchctl", args: ["bootout", "gui/501/uk.let-trent.default"] }]);
    expect(result.state).toBe("removed");
    expect(result.ran).toMatchObject([{ command: "launchctl bootout gui/501/uk.let-trent.default", code: 3 }]);
  });

  it("Linux: disable --now before removal, daemon-reload after", () => {
    installService(options("linux"));
    const printed = uninstallService({ host: host("linux"), profile: "default", dryRun: true });
    expect(printed.state).toBe("would-remove");
    expect(printed.next).toEqual(["systemctl --user disable --now trent-default.service", "systemctl --user daemon-reload"]);
    const result = uninstallService({ host: host("linux"), profile: "default", now: true });
    expect(result.state).toBe("removed");
    expect(calls).toEqual([
      { command: "systemctl", args: ["--user", "disable", "--now", "trent-default.service"] },
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });
});

describe("readServiceStatus", () => {
  it("nothing installed, no lock, no log", () => {
    expect(readServiceStatus({ host: host("darwin"), profile: "default", profileDir })).toEqual({
      supported: true,
      manager: "launchd",
      label: "uk.let-trent.default",
      unitPath: path.join(home, "Library", "LaunchAgents", "uk.let-trent.default.plist"),
      installed: false,
      gateway: { held: false },
      daemon: { running: false },
      logFile: serviceLogPaths(profileDir).service,
      lastLog: [],
    });
  });

  it("installed, the gateway lock's live holder and the daemon's writer pid, and the last five log lines", () => {
    installService(options("darwin"));
    const lock = acquireProfileLock({ profileDir, role: "gateway", label: "gateway" });
    expect(lock.ok).toBe(true);
    if (lock.ok) releases.push(lock.release);
    releases.push(acquireProfileWriter(profileDir, "service"));
    fs.writeFileSync(serviceLogPaths(profileDir).service, ["1", "2", "3", "4", "5", "6"].map((n) => `line ${n}`).join("\n") + "\n");
    const status = readServiceStatus({ host: host("darwin"), profile: "default", profileDir });
    expect(status.installed).toBe(true);
    expect(status.gateway).toMatchObject({ held: true, pid: process.pid, label: "gateway" });
    expect(status.daemon).toMatchObject({ running: true, pid: process.pid });
    expect(status.lastLog).toEqual(["line 2", "line 3", "line 4", "line 5", "line 6"]);
  });

  it("a writer that is not the daemon is not reported as the daemon; a live gateway in another process is", () => {
    releases.push(acquireProfileWriter(profileDir, "repl"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    const file = path.join(profileDir, "locks", "gateway.lock");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: child.pid, startedAt: "2026-09-25T08:00:00.000Z", label: "gateway", hostname: os.hostname() }));
    const status = readServiceStatus({ host: host("linux"), profile: "default", profileDir });
    expect(status.daemon).toEqual({ running: false });
    expect(status.gateway).toMatchObject({ held: true, pid: child.pid });
  });

  it("Windows: unsupported, still reports the lock and the log", () => {
    expect(readServiceStatus({ host: host("win32"), profile: "default", profileDir })).toMatchObject({ supported: false, unitPath: null, installed: false, gateway: { held: false } });
  });
});
