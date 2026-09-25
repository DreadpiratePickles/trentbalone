/**
 * `trent service install|uninstall|status`: where the unit file goes, writing and removing it,
 * the exact next command, and what is running now.
 *
 * Every path comes from the injected `ServiceHost` (the home directory, an explicit unit
 * directory, `$XDG_CONFIG_HOME`), and every launchctl/systemctl call goes through its `exec`, so a
 * test drives all of it against a scratch directory with a recorder and nothing touches the real
 * ~/Library/LaunchAgents or ~/.config/systemd/user. Without `now` no command is ever run: the
 * result carries the lines to run instead.
 *
 * Status reads the profile's lock files through `../profile/locks.ts`: the gateway lock's live
 * holder, and the daemon itself as the live writer whose label includes `service` (the daemon
 * registers that label for its whole life, gateway on or off).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { EXIT, TrentError } from "../errors/index.js";
import { liveGatewayHolder, liveWriters } from "../profile/locks.js";
import { serviceLogPaths, tailServiceLog } from "./service-log.js";
import { assertServiceProfileName, daemonArguments, renderLaunchdPlist, renderSystemdUnit, serviceEnvironment, serviceLabel, servicePathValue, systemdUnitName } from "./units.js";

export interface ServiceExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The machine the service is installed on. Everything outside the profile comes from here. */
export interface ServiceHost {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  /** For launchd's `gui/<uid>` domain. */
  readonly uid: number;
  readonly xdgConfigHome?: string | undefined;
  /** Overrides `<home>/Library/LaunchAgents`. */
  readonly launchAgentsDir?: string | undefined;
  /** Overrides `$XDG_CONFIG_HOME/systemd/user` and `<home>/.config/systemd/user`. */
  readonly systemdUserDir?: string | undefined;
  /** Runs launchctl or systemctl; called only when the caller passed `now`. */
  readonly exec: (command: string, args: readonly string[]) => ServiceExecResult;
}

export type ServiceManager = "launchd" | "systemd";

export type ServiceTarget =
  | { readonly supported: true; readonly manager: ServiceManager; readonly label: string; readonly unitPath: string }
  | { readonly supported: false; readonly platform: string };

export interface ServiceInstallOptions {
  readonly host: ServiceHost;
  readonly profile: string;
  readonly profileDir: string;
  /** `TRENT_HOME` as the daemon must see it: the base directory the profile hangs off. */
  readonly trentHome: string;
  /** What runs (`./program.ts`); the daemon's arguments are appended here. */
  readonly program: readonly string[];
  readonly workingDirectory: string;
  /** `PATH` at install time, carried into the unit as `servicePathValue` normalises it. */
  readonly pathEnv: string;
  /** Replace a DIFFERENT existing unit file; an identical one is never refused. */
  readonly force?: boolean | undefined;
  /** Run the load/enable commands through `host.exec` instead of only printing them. */
  readonly now?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ServiceCommandRun {
  readonly command: string;
  readonly code: number;
  readonly stderr?: string;
}

export interface ServiceInstallResult {
  readonly manager: ServiceManager;
  readonly label: string;
  readonly unitPath: string;
  readonly state: "written" | "replaced" | "unchanged" | "would-write";
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly logs: { readonly service: string; readonly stdout: string; readonly stderr: string };
  readonly next: readonly string[];
  readonly ran: readonly ServiceCommandRun[];
  /** False when a command run for `now` failed. */
  readonly ok: boolean;
  readonly content: string;
}

export interface ServiceUninstallOptions {
  readonly host: ServiceHost;
  readonly profile: string;
  readonly now?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ServiceUninstallResult {
  readonly manager: ServiceManager;
  readonly label: string;
  readonly unitPath: string;
  readonly state: "removed" | "absent" | "would-remove";
  readonly next: readonly string[];
  readonly ran: readonly ServiceCommandRun[];
}

export interface ServiceStatusOptions {
  readonly host: ServiceHost;
  readonly profile: string;
  readonly profileDir: string;
  /** How many log lines to return; 5 by default. */
  readonly lines?: number | undefined;
}

export interface ServiceStatus {
  readonly supported: boolean;
  readonly platform?: string;
  readonly manager?: ServiceManager;
  readonly label?: string;
  readonly unitPath: string | null;
  readonly installed: boolean;
  readonly gateway: { readonly held: boolean; readonly pid?: number; readonly label?: string; readonly startedAt?: string };
  readonly daemon: { readonly running: boolean; readonly pid?: number; readonly label?: string; readonly startedAt?: string };
  readonly logFile: string;
  readonly lastLog: readonly string[];
}

/** A command as argv, and whether its failure is expected (unloading what may not be loaded). */
interface Planned {
  readonly argv: readonly string[];
  readonly mayFail: boolean;
}

const UNIT_FILE_MODE = 0o644;
const UNIT_DIR_MODE = 0o755;
const LOG_DIR_MODE = 0o700;

export function serviceTarget(host: ServiceHost, profile: string): ServiceTarget {
  if (host.platform === "darwin") {
    const dir = host.launchAgentsDir ?? path.join(host.homeDir, "Library", "LaunchAgents");
    const label = serviceLabel(profile);
    return { supported: true, manager: "launchd", label, unitPath: path.join(dir, `${label}.plist`) };
  }
  if (host.platform === "linux") {
    const dir = host.systemdUserDir ?? path.join(host.xdgConfigHome ?? path.join(host.homeDir, ".config"), "systemd", "user");
    const unit = systemdUnitName(profile);
    return { supported: true, manager: "systemd", label: unit, unitPath: path.join(dir, unit) };
  }
  return { supported: false, platform: host.platform };
}

/** The refusal on a platform with neither manager, and the Task Scheduler line that does the job. */
export function unsupportedService(platform: string, program: readonly string[], profile: string): { message: string; alternative: string } {
  const run = [...program.map((arg) => `\\"${arg}\\"`), "service", "daemon", "--profile", profile].join(" ");
  return {
    message: `trent service install is not supported on ${platform}: there is no launchd or systemd user manager here to supervise it. Run the daemon at log on from Task Scheduler instead (and stop it there with End)`,
    alternative: `schtasks /Create /TN "Trent ${profile}" /SC ONLOGON /TR "${run}"`,
  };
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

function render(command: Planned): string {
  return command.argv.map(shellWord).join(" ");
}

function run(host: ServiceHost, commands: readonly Planned[]): { ran: ServiceCommandRun[]; ok: boolean } {
  const ran: ServiceCommandRun[] = [];
  for (const command of commands) {
    const [bin, ...args] = command.argv;
    const result = host.exec(bin!, args);
    const stderr = result.stderr.trim();
    ran.push({ command: render(command), code: result.code, ...(result.code !== 0 && stderr !== "" ? { stderr } : {}) });
    if (result.code !== 0 && !command.mayFail) return { ran, ok: false };
  }
  return { ran, ok: true };
}

function supportedTarget(host: ServiceHost, profile: string, program: readonly string[], operation: string): Extract<ServiceTarget, { supported: true }> {
  assertServiceProfileName(profile);
  const target = serviceTarget(host, profile);
  if (!target.supported) {
    const { message, alternative } = unsupportedService(target.platform, program, profile);
    throw new TrentError({ code: EXIT.CONFIG, operation, message: `${message}: ${alternative}`, target: target.platform });
  }
  return target;
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Temp file then rename: launchd and systemd never read half a unit. */
function writeUnit(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: UNIT_DIR_MODE });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, { mode: UNIT_FILE_MODE });
  fs.chmodSync(tmp, UNIT_FILE_MODE);
  fs.renameSync(tmp, file);
}

function installCommands(host: ServiceHost, target: Extract<ServiceTarget, { supported: true }>, replaced: boolean): Planned[] {
  if (target.manager === "launchd") {
    const bootstrap: Planned = { argv: ["launchctl", "bootstrap", `gui/${host.uid}`, target.unitPath], mayFail: false };
    // A loaded agent keeps running its old definition until it is booted out.
    return replaced ? [{ argv: ["launchctl", "bootout", `gui/${host.uid}/${target.label}`], mayFail: true }, bootstrap] : [bootstrap];
  }
  const reload: Planned = { argv: ["systemctl", "--user", "daemon-reload"], mayFail: false };
  if (!replaced) return [reload, { argv: ["systemctl", "--user", "enable", "--now", target.label], mayFail: false }];
  return [reload, { argv: ["systemctl", "--user", "enable", target.label], mayFail: false }, { argv: ["systemctl", "--user", "restart", target.label], mayFail: false }];
}

export function installService(options: ServiceInstallOptions): ServiceInstallResult {
  const { host, profile } = options;
  const target = supportedTarget(host, profile, options.program, "service.install");
  const logs = serviceLogPaths(options.profileDir);
  const programArguments = daemonArguments(options.program, profile);
  const spec = {
    profile,
    programArguments,
    workingDirectory: options.workingDirectory,
    environment: serviceEnvironment({ trentHome: options.trentHome, profile, path: servicePathValue(options.pathEnv) }),
    stdoutPath: logs.stdout,
    stderrPath: logs.stderr,
  };
  const content = target.manager === "launchd" ? renderLaunchdPlist(spec) : renderSystemdUnit(spec);
  const existing = readIfPresent(target.unitPath);
  const differs = existing !== undefined && existing !== content;
  if (differs && options.force !== true && options.dryRun !== true) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "service.install",
      message: "a different service file is already installed here; pass --force to replace it, or run trent service uninstall first",
      target: target.unitPath,
    });
  }
  const state = options.dryRun === true ? "would-write" : existing === undefined ? "written" : differs ? "replaced" : "unchanged";
  const commands = installCommands(host, target, state === "replaced");
  let outcome: { ran: ServiceCommandRun[]; ok: boolean } = { ran: [], ok: true };
  if (options.dryRun !== true) {
    // launchd opens StandardOutPath/StandardErrorPath but does not create their directory.
    fs.mkdirSync(logs.dir, { recursive: true, mode: LOG_DIR_MODE });
    if (state !== "unchanged") writeUnit(target.unitPath, content);
    if (options.now === true) outcome = run(host, commands);
  }
  return {
    manager: target.manager,
    label: target.label,
    unitPath: target.unitPath,
    state,
    programArguments,
    workingDirectory: options.workingDirectory,
    logs: { service: logs.service, stdout: logs.stdout, stderr: logs.stderr },
    next: commands.map(render),
    ran: outcome.ran,
    ok: outcome.ok,
    content,
  };
}

export function uninstallService(options: ServiceUninstallOptions): ServiceUninstallResult {
  const { host, profile } = options;
  const target = supportedTarget(host, profile, [], "service.uninstall");
  // Stopping may fail when nothing is loaded; that is the state uninstall is heading for anyway.
  const before: Planned[] =
    target.manager === "launchd"
      ? [{ argv: ["launchctl", "bootout", `gui/${host.uid}/${target.label}`], mayFail: true }]
      : [{ argv: ["systemctl", "--user", "disable", "--now", target.label], mayFail: true }];
  const after: Planned[] = target.manager === "systemd" ? [{ argv: ["systemctl", "--user", "daemon-reload"], mayFail: true }] : [];
  const exists = fs.existsSync(target.unitPath);
  const next = [...before, ...after].map(render);
  const base = { manager: target.manager, label: target.label, unitPath: target.unitPath, next };
  if (options.dryRun === true) return { ...base, state: exists ? "would-remove" : "absent", ran: [] };
  const ran: ServiceCommandRun[] = [];
  if (options.now === true) ran.push(...run(host, before).ran);
  if (exists) fs.rmSync(target.unitPath, { force: true });
  if (options.now === true) ran.push(...run(host, after).ran);
  return { ...base, state: exists ? "removed" : "absent", ran };
}

export function readServiceStatus(options: ServiceStatusOptions): ServiceStatus {
  assertServiceProfileName(options.profile);
  const target = serviceTarget(options.host, options.profile);
  const holder = liveGatewayHolder(options.profileDir);
  const daemon = liveWriters(options.profileDir).find((writer) => writer.label.split("+").includes("service"));
  const logFile = serviceLogPaths(options.profileDir).service;
  const common = {
    gateway: holder === null ? { held: false } : { held: true, pid: holder.pid, label: holder.label, startedAt: holder.startedAt },
    daemon: daemon === undefined ? { running: false } : { running: true, pid: daemon.pid, label: daemon.label, startedAt: daemon.startedAt },
    logFile,
    lastLog: tailServiceLog(logFile, options.lines ?? 5),
  };
  if (!target.supported) return { supported: false, platform: target.platform, unitPath: null, installed: false, ...common };
  return { supported: true, manager: target.manager, label: target.label, unitPath: target.unitPath, installed: fs.existsSync(target.unitPath), ...common };
}
