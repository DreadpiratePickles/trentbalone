/**
 * The unit files `trent service install` writes: a launchd user agent (macOS) and a systemd user
 * unit (Linux). Pure rendering; `./install.ts` decides where the text goes.
 *
 * Both run `trent service daemon --profile <p> --no-color` by absolute path (`./program.ts`),
 * restart it whenever it exits, start it at login, and carry exactly four environment variables:
 * `TRENT_HOME` and `TRENT_PROFILE` so the daemon finds the same profile the installer saw,
 * `PATH` as it was at install time (`servicePathValue`) so docker, git and the sandboxes resolve, and
 * `TRENT_QUEUE_FALLBACK=disabled` (AGENTS.md, the standalone environment contract). A secret is
 * never written into a unit: the daemon reads the profile's `.env` itself, as every surface does.
 */
import { EXIT, TrentError } from "../errors/index.js";

/** Reverse-DNS of the product's domain, let-trent.uk. */
export const SERVICE_LABEL_PREFIX = "uk.let-trent";

/** The daemon exits 130 after a signal-driven release (apps/cli/src/signals.ts): a clean stop. */
export const DAEMON_SIGNAL_EXIT = 130;

/** How long launchd waits before restarting a daemon that exited, in seconds. */
export const LAUNCHD_THROTTLE_SECONDS = 30;

/** How long systemd waits before restarting it, in seconds. */
export const SYSTEMD_RESTART_SECONDS = 10;

const PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

export interface ServiceUnitSpec {
  readonly profile: string;
  /** The whole argv: the program (`./program.ts`) then `service daemon --profile <p>`. */
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  /** launchd only: where the daemon's stdout and stderr go. systemd sends both to the journal. */
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * A profile name lands in a file name and a launchd label, so it is held to what both accept.
 * `ConfigManager` itself does not constrain the name; this is the service's own refusal.
 */
export function assertServiceProfileName(profile: string): void {
  if (!PROFILE_NAME.test(profile)) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "service.profile",
      message: "a service profile name must be 1-64 characters of letters, digits, '.', '_' or '-', and must not start with '.' or '-'",
      target: profile,
    });
  }
}

export function serviceLabel(profile: string): string {
  return `${SERVICE_LABEL_PREFIX}.${profile}`;
}

export function systemdUnitName(profile: string): string {
  return `trent-${profile}.service`;
}

/**
 * The program, then `service daemon --profile <p> --no-color`: under launchd the daemon's output
 * lands in a file, and colour is decided from the environment rather than from a terminal
 * (`apps/cli/src/ui/capabilities.ts`), so it is switched off here rather than written as escapes.
 */
export function daemonArguments(program: readonly string[], profile: string): string[] {
  return [...program, "service", "daemon", "--profile", profile, "--no-color"];
}

/** What a service falls back to when the install-time PATH holds nothing usable. */
export const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The install-time PATH as a service can use it: absolute entries only (neither launchd nor
 * systemd expands `~` or resolves a relative entry), each once, in the order the shell had them.
 */
export function servicePathValue(pathEnv: string): string {
  const kept = [...new Set(pathEnv.split(":").filter((entry) => entry.startsWith("/")))];
  return kept.length > 0 ? kept.join(":") : SYSTEM_PATH;
}

export function serviceEnvironment(input: { readonly trentHome: string; readonly profile: string; readonly path: string }): Record<string, string> {
  return { PATH: input.path, TRENT_HOME: input.trentHome, TRENT_PROFILE: input.profile, TRENT_QUEUE_FALLBACK: "disabled" };
}

/** Every value the unit carries, checked once: a control character would break either format. */
function assertPrintable(spec: ServiceUnitSpec): void {
  const values = [spec.profile, ...spec.programArguments, spec.workingDirectory, spec.stdoutPath, spec.stderrPath, ...Object.entries(spec.environment).flat()];
  for (const value of values) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "service.render",
        message: "a value in the service unit contains a control character (a newline would end the line and start a new key)",
        target: JSON.stringify(value),
      });
    }
  }
}

// ── launchd ──────────────────────────────────────────────────────────────────────────────────

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function plistString(value: string, indent: string): string {
  return `${indent}<string>${xml(value)}</string>`;
}

export function renderLaunchdPlist(spec: ServiceUnitSpec): string {
  assertServiceProfileName(spec.profile);
  assertPrintable(spec);
  const key = (name: string): string => `  <key>${name}</key>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    key("Label"),
    plistString(serviceLabel(spec.profile), "  "),
    key("ProgramArguments"),
    "  <array>",
    ...spec.programArguments.map((arg) => plistString(arg, "    ")),
    "  </array>",
    key("WorkingDirectory"),
    plistString(spec.workingDirectory, "  "),
    key("EnvironmentVariables"),
    "  <dict>",
    ...Object.entries(spec.environment).flatMap(([name, value]) => [`    <key>${xml(name)}</key>`, plistString(value, "    ")]),
    "  </dict>",
    key("RunAtLoad"),
    "  <true/>",
    key("KeepAlive"),
    "  <true/>",
    key("ThrottleInterval"),
    `  <integer>${LAUNCHD_THROTTLE_SECONDS}</integer>`,
    key("ProcessType"),
    "  <string>Background</string>",
    key("StandardOutPath"),
    plistString(spec.stdoutPath, "  "),
    key("StandardErrorPath"),
    plistString(spec.stderrPath, "  "),
    "</dict>",
    "</plist>",
  ];
  return `${lines.join("\n")}\n`;
}

// ── systemd ──────────────────────────────────────────────────────────────────────────────────

/** `%` starts a specifier in every systemd value; doubling it makes it literal. */
function systemdLiteral(value: string): string {
  return value.replace(/%/g, "%%");
}

/** One double-quoted word of a command line: `\` and `"` escaped, `%` and `$` doubled. */
function systemdWord(value: string): string {
  return `"${systemdLiteral(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

/** One double-quoted `Environment=` assignment; `$` is not expanded there, so it stays single. */
function systemdAssignment(name: string, value: string): string {
  return `"${systemdLiteral(`${name}=${value}`).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderSystemdUnit(spec: ServiceUnitSpec): string {
  assertServiceProfileName(spec.profile);
  assertPrintable(spec);
  const lines = [
    `# Trent Fleet for profile ${spec.profile}: rendered by \`trent service install\`, removed by \`trent service uninstall\`.`,
    "[Unit]",
    `Description=Trent Fleet (profile ${spec.profile}): messaging gateway, cron runner and heartbeat`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.programArguments.map(systemdWord).join(" ")}`,
    `WorkingDirectory=${systemdLiteral(spec.workingDirectory)}`,
    ...Object.entries(spec.environment).map(([name, value]) => `Environment=${systemdAssignment(name, value)}`),
    "Restart=always",
    `RestartSec=${SYSTEMD_RESTART_SECONDS}`,
    `SuccessExitStatus=${DAEMON_SIGNAL_EXIT}`,
    "",
    "[Install]",
    "WantedBy=default.target",
  ];
  return `${lines.join("\n")}\n`;
}
