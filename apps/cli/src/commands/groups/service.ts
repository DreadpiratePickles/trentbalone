/**
 * The `service` group: `trent service daemon | install | uninstall | status`.
 *
 * Hermes installs one supervised service (`hermes gateway install`); Trent used to need three
 * foreground processes (`gateway start`, `cron start`, `heartbeat start`), so the assistant stopped
 * when the laptop rebooted. `daemon` runs all three in one process (`./service-daemon.ts`);
 * `install` writes a launchd user agent (macOS) or a systemd user unit (Linux) that starts it at
 * login and restarts it when it exits, and prints the exact command that loads it (`--now` runs
 * it). `status` says whether the unit is installed, which pid holds the gateway lock, which pid
 * is the daemon, and the last lines of `<profile>/logs/service.log`. Rendering, paths and the
 * lock reads are `@trent/core/service`; this file only gathers the host.
 *
 * The host (platform, home directory, uid, the launchctl/systemctl runner, the running process)
 * is injected through `setServiceHostForTests`, so a test never writes to the real
 * ~/Library/LaunchAgents or ~/.config/systemd/user and never runs a service manager.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EXIT } from "@trent/core/errors/index.js";
import {
  EPHEMERAL_SERVICE_REFUSAL, // [C10]
  assertServiceProfileName,
  installService,
  readServiceStatus,
  resolveServiceProgram,
  serviceDurability, // [C10]
  serviceDurabilityLine, // [C10]
  serviceTarget,
  uninstallService,
  unsupportedService,
  type ServiceDurability, // [C10]
  type ServiceHost,
  type ServiceInstallResult,
  type ServiceProcessView,
  type ServiceStatus,
  type ServiceUninstallResult,
} from "@trent/core/service/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";
import { runServiceDaemon, type DaemonPlanEntry } from "./service-daemon.js";

/** Everything `install|uninstall|status` read from the machine and the running process. */
export interface CliServiceHost extends ServiceHost {
  readonly processView: ServiceProcessView;
  readonly realpath: (p: string) => string;
  /** The default working directory of the service: where `install` was run. */
  readonly cwd: string;
  /** `PATH` carried into the unit. */
  readonly pathEnv: string;
}

let hostOverride: Partial<CliServiceHost> | undefined;

/** Replaces the host for tests; `undefined` restores the real one. */
export function setServiceHostForTests(host: Partial<CliServiceHost> | undefined): void {
  hostOverride = host;
}

function realHost(): CliServiceHost {
  return {
    platform: process.platform,
    homeDir: os.homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    xdgConfigHome: process.env.XDG_CONFIG_HOME !== undefined && process.env.XDG_CONFIG_HOME !== "" ? process.env.XDG_CONFIG_HOME : undefined,
    exec: (command, args) => {
      const result = spawnSync(command, [...args], { encoding: "utf8" });
      return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
    },
    processView: { execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, bunVersion: process.versions.bun },
    realpath: (p) => fs.realpathSync(p),
    cwd: process.cwd(),
    pathEnv: process.env.PATH ?? "/usr/bin:/bin",
  };
}

function serviceHost(): CliServiceHost {
  if (hostOverride === undefined) return realHost();
  // An injected home must not inherit the real $XDG_CONFIG_HOME: that would point back at this machine.
  return { ...realHost(), xdgConfigHome: undefined, ...hostOverride };
}

function program(host: CliServiceHost): string[] {
  return resolveServiceProgram(host.processView, host.realpath).argv;
}

/** `--workdir` resolved against where the command runs; absent, that directory itself. */
function workdir(host: CliServiceHost, opts: Record<string, unknown>): string {
  return typeof opts.workdir === "string" && opts.workdir !== "" ? path.resolve(host.cwd, opts.workdir) : host.cwd;
}

/** The refusal on Windows, as data: the message, the manual alternative, exit 3. */
function unsupported(ctx: CommandContext, host: CliServiceHost, operation: string) {
  assertServiceProfileName(ctx.profile);
  const target = serviceTarget(host, ctx.profile);
  if (target.supported) return undefined;
  const text = unsupportedService(target.platform, program(host), ctx.profile);
  return { data: { supported: false, command: operation, platform: target.platform, ...text }, exitCode: EXIT.CONFIG };
}

function renderUnsupported(data: Record<string, unknown>, ctx: CommandContext): string[] {
  return [`  ${ctx.theme.error(String(data.message))}`, `  ${ctx.theme.value(String(data.alternative))}`];
}

function nextLines(next: readonly string[], ctx: CommandContext): string[] {
  return next.map((line, index) => `  ${ctx.theme.meta(index === 0 ? "next     " : "         ")} ${ctx.theme.value(line)}`);
}

function ranLines(ran: ServiceInstallResult["ran"], ctx: CommandContext): string[] {
  return ran.map((r) => `  ${r.code === 0 ? ctx.theme.success("ran      ") : ctx.theme.error(`exit ${r.code}   `.slice(0, 9))} ${ctx.theme.value(r.command)}${r.stderr === undefined ? "" : ` ${ctx.theme.meta(r.stderr)}`}`);
}

export const serviceSpec: CommandSpec = {
  name: "service",
  description: "Run the gateway, cron runner and heartbeat as one supervised service that survives a reboot (launchd on macOS, systemd on Linux)",
  subcommands: [
    {
      name: "daemon",
      description: "Run the gateway (if gateway.enabled), the cron runner and the heartbeat (if heartbeat.enabled) in this one foreground process",
      run: (ctx) => runServiceDaemon(ctx),
      render(data, ctx) {
        const d = data as { dryRun?: boolean; pid?: number; profile: string; components: Array<DaemonPlanEntry | { name: string; state: string; detail?: string }>; log?: string };
        const lines = [
          d.dryRun === true
            ? `  ${ctx.theme.meta("would run the service for profile")} ${ctx.theme.value(d.profile)}`
            : `  ${ctx.theme.success("service running")} ${ctx.theme.meta(`pid ${String(d.pid)}, profile ${d.profile}`)}`,
        ];
        for (const c of d.components) {
          const state = c.state === "skipped" ? ctx.theme.meta(c.state.padEnd(11, " ")) : ctx.theme.success(c.state.padEnd(11, " "));
          lines.push(`  ${ctx.theme.value(c.name.padEnd(10, " "))} ${state} ${ctx.theme.meta(c.detail ?? "")}`.trimEnd());
        }
        if (d.log !== undefined) lines.push(ctx.theme.meta(`  log ${d.log}; SIGTERM or Ctrl+C stops it`));
        return lines;
      },
    },
    {
      name: "install",
      description: "Write the launchd agent or systemd user unit that runs `trent service daemon` at login, and print the command that loads it",
      options: [
        { flags: "--force", description: "Replace a different unit file already installed for this profile" },
        { flags: "--now", description: "Also load it now (launchctl bootstrap / systemctl --user enable --now) instead of only printing the command" },
        { flags: "--workdir <dir>", description: "The service's working directory; defaults to the current one" },
        { flags: "--allow-ephemeral", description: "Install even when the daemon would have no durable store (under Node), so its runs, approvals and audit are lost at every restart" }, // [C10]
      ],
      run(ctx, opts) {
        const host = serviceHost();
        const refused = unsupported(ctx, host, "service install");
        if (refused !== undefined) return refused;
        // [C10] The unit runs this process's runtime; under Node the daemon would keep nothing across a restart.
        // A dry run writes nothing, so it refuses nothing: it reports that the real install would.
        const durability = serviceDurability(host.processView);
        const wouldRefuse = !durability.durable && opts.allowEphemeral !== true;
        if (wouldRefuse && !ctx.dryRun) return { data: { command: "service install", ...durability, message: EPHEMERAL_SERVICE_REFUSAL }, exitCode: EXIT.CONFIG };
        const manager = ctx.config();
        const result = installService({
          host,
          profile: ctx.profile,
          profileDir: manager.getProfileDir(),
          trentHome: manager.getBaseDir(),
          program: program(host),
          workingDirectory: workdir(host, opts),
          pathEnv: host.pathEnv,
          force: opts.force === true,
          now: opts.now === true,
          dryRun: ctx.dryRun,
        });
        // The file is on disk and `status` shows it; the text is echoed only when nothing was written.
        const { content, ...written } = result;
        const data = { ...(ctx.dryRun ? { dryRun: true, ...written, content } : written), ...durability, ...(wouldRefuse ? { wouldRefuse: true, message: EPHEMERAL_SERVICE_REFUSAL } : {}) }; // [C10] durable, and why not
        return result.ok ? { data } : { data, exitCode: EXIT.RUN_FAILED };
      },
      render(data, ctx) {
        const d = data as Record<string, unknown> & Partial<ServiceInstallResult>;
        if (d.supported === false) return renderUnsupported(d, ctx);
        if (d.state === undefined && d.durable === false) return [`  ${ctx.theme.error(String(d.message))}`]; // [C10] the refusal
        const store = serviceDurabilityLine(d as unknown as ServiceDurability); // [C10]
        const lines = [
          `  ${ctx.theme.success(String(d.state).padEnd(9, " "))} ${ctx.theme.value(String(d.unitPath))}`,
          `  ${ctx.theme.meta("runs     ")} ${ctx.theme.value((d.programArguments ?? []).join(" "))}`,
          `  ${ctx.theme.meta("in       ")} ${ctx.theme.value(String(d.workingDirectory))}`,
          `  ${ctx.theme.meta("logs     ")} ${ctx.theme.value(String(d.logs?.service))} ${ctx.theme.meta(d.manager === "launchd" ? `(stdout and stderr beside it)` : "(stdout and stderr in the journal)")}`,
          `  ${ctx.theme.meta("store    ")} ${d.durable === true ? ctx.theme.success(store) : ctx.theme.needsApproval(store)}`, // [C10]
          ...(d.wouldRefuse === true ? [`  ${ctx.theme.error(String(d.message))}`] : []), // [C10] a dry run of what the real install refuses
          ...ranLines(d.ran ?? [], ctx),
        ];
        if ((d.ran ?? []).length === 0) lines.push(...nextLines(d.next ?? [], ctx));
        return lines;
      },
    },
    {
      name: "uninstall",
      description: "Remove this profile's launchd agent or systemd user unit, and print the command that unloads it",
      options: [{ flags: "--now", description: "Also unload it now (launchctl bootout / systemctl --user disable --now) before the file is removed" }],
      run(ctx, opts) {
        const host = serviceHost();
        const refused = unsupported(ctx, host, "service uninstall");
        if (refused !== undefined) return refused;
        const result = uninstallService({ host, profile: ctx.profile, now: opts.now === true, dryRun: ctx.dryRun });
        return { data: ctx.dryRun ? { dryRun: true, ...result } : { ...result } };
      },
      render(data, ctx) {
        const d = data as Record<string, unknown> & Partial<ServiceUninstallResult>;
        if (d.supported === false) return renderUnsupported(d, ctx);
        const lines = [`  ${d.state === "absent" ? ctx.theme.meta("absent   ") : ctx.theme.success(String(d.state).padEnd(9, " "))} ${ctx.theme.value(String(d.unitPath))}`, ...ranLines(d.ran ?? [], ctx)];
        if ((d.ran ?? []).length === 0) lines.push(...nextLines(d.next ?? [], ctx));
        return lines;
      },
    },
    {
      name: "status",
      description: "Whether the service unit is installed, which pid holds the gateway lock, which pid is the daemon, and the last log lines",
      run(ctx) {
        const status = readServiceStatus({ host: serviceHost(), profile: ctx.profile, profileDir: ctx.config().getProfileDir() });
        return { data: { profile: ctx.profile, ...status } as unknown as Record<string, unknown> };
      },
      render(data, ctx) {
        const d = data as unknown as ServiceStatus & { profile: string };
        const lines = [ctx.theme.emphasis(`TRENT SERVICE (profile ${d.profile})`)];
        lines.push(
          !d.supported
            ? `  ${ctx.theme.meta("unit     ")} ${ctx.theme.meta(`unsupported on ${d.platform ?? "this platform"}; trent service install prints the manual alternative`)}`
            : `  ${ctx.theme.meta("unit     ")} ${d.installed ? ctx.theme.success("installed") : ctx.theme.meta("not installed")} ${ctx.theme.value(d.unitPath ?? "")}`,
        );
        lines.push(
          d.daemon.running
            ? `  ${ctx.theme.meta("daemon   ")} ${ctx.theme.success("running")} ${ctx.theme.value(`pid ${String(d.daemon.pid)}`)} ${ctx.theme.meta(`since ${d.daemon.startedAt ?? "?"}`)}`
            : `  ${ctx.theme.meta("daemon   ")} ${ctx.theme.meta("not running")}`,
        );
        lines.push(
          d.gateway.held
            ? `  ${ctx.theme.meta("gateway  ")} ${ctx.theme.success("lock held")} ${ctx.theme.value(`pid ${String(d.gateway.pid)}`)} ${ctx.theme.meta(d.gateway.label ?? "")}`
            : `  ${ctx.theme.meta("gateway  ")} ${ctx.theme.meta("lock not held")}`,
        );
        lines.push(`  ${ctx.theme.meta("log      ")} ${ctx.theme.value(d.logFile)}`);
        for (const line of d.lastLog) lines.push(`    ${ctx.theme.body(line)}`);
        if (d.lastLog.length === 0) lines.push(ctx.theme.meta("    empty; trent service daemon writes one line per start and stop"));
        return lines;
      },
    },
  ],
};
