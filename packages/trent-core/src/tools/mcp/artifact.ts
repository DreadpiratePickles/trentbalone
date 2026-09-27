/**
 * [D13] The stdio artifact pin: what a consent records about the code that actually runs.
 *
 * The launch-spec hash (`consent.ts`) pins the argv, and the argv of `npx some-server@latest` or
 * `node ./server.js` stays the same while the code under it changes (council red team, Break 16). A
 * consent therefore also records an artifact pin, re-checked before every spawn:
 *
 * - package launchers (npx, pnpx, bunx, `npm exec`, `pnpm dlx`, `yarn dlx`, `bun x`, uvx, `pipx run`,
 *   `uv tool run`): every package they fetch must name an EXACT version (`pkg@1.2.3`, `pkg==1.2.3`),
 *   and `docker|podman run` must name its image by `@sha256:` digest. npm and PyPI refuse to replace a
 *   published version, so an exact version is an artifact identity that costs nothing to re-check. A
 *   floating spec (`@latest`, a range, no version) is refused at consent time: resolving it would need
 *   the network, and recording it would pin nothing. The fix is one edit to the argv.
 * - interpreters (node, python, bun, deno, uv run, tsx, ruby, sh, ...): the script file(s) the argv
 *   names, by content. Inline code (`-e`, `-c`) is already pinned by the argv itself.
 * - anything else: the command binary, resolved on the child's PATH and through symlinks, by content.
 *
 * A file inside `node_modules/<pkg>/` also pins that package's `package.json`, so an upgrade that
 * leaves the entry file byte-identical still turns the pin over. Spawn-time cost stays small: each
 * file's stat fingerprint (device, inode, size, mtime, ctime) is recorded, and an unchanged fingerprint
 * skips the hash. ctime cannot be set by an unprivileged process, so any write moves it.
 *
 * Forms that cannot be pinned without resolving something at run time (`python -m`, `npm start`, a
 * wrapper such as `sh -c "npx ..."`) are refused, never recorded and warned about.
 *
 * This module reads files only; it never opens a socket or spawns anything.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../../config/schema.js";
import { resolveTemplateRecord } from "./config.js";

type StdioConfig = Extract<McpServerConfig, { transport: "stdio" }>;

export interface McpArtifactPin {
  /** package: an exact registry version or image digest; file: content digests; inline: code in the argv. */
  readonly kind: "package" | "file" | "inline";
  /** sha256 over the canonical identity (package specs, or each file's path and content digest). */
  readonly digest: string;
  /** file only: sha256 over each file's stat fingerprint; equal means unchanged, so no re-hash. */
  readonly stat?: string;
}

export type McpArtifactResolution =
  | { readonly ok: true; readonly pin: McpArtifactPin }
  /** unpinned: the argv must change (name an exact version); unresolved: the file is not there (yet). */
  | { readonly ok: false; readonly code: "unpinned" | "unresolved"; readonly reason: string };

export interface McpArtifactOptions {
  /** The directory the child runs in; relative paths resolve against it. */
  readonly cwd: string;
  /** The host env; the entry's own `env` (resolved against it) overrides PATH as the spawn would. */
  readonly env: NodeJS.ProcessEnv;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

type Eco = "npm" | "pypi";
/** Launcher -> ecosystem, keyed by the command's basename plus the subcommand words it needs. */
const LAUNCHERS: readonly [string, readonly string[], Eco][] = [
  ["npx", [], "npm"], ["pnpx", [], "npm"], ["bunx", [], "npm"], ["npm", ["exec"], "npm"], ["npm", ["x"], "npm"],
  ["pnpm", ["dlx"], "npm"], ["yarn", ["dlx"], "npm"], ["bun", ["x"], "npm"],
  ["uvx", [], "pypi"], ["pipx", ["run"], "pypi"], ["uv", ["tool", "run"], "pypi"],
];
/** Flags whose value is a package the launcher installs; each must be pinned. */
const PACKAGE_FLAGS: Record<Eco, readonly string[]> = { npm: ["-p", "--package"], pypi: ["--from", "--spec", "--with"] };
/** Flags whose value is not a package (skipped so the value is not read as the package). */
const VALUE_FLAGS: Record<Eco, readonly string[]> = {
  npm: ["--cache", "--registry", "--userconfig", "--prefix"],
  pypi: ["--python", "-p", "--index-url", "-i", "--extra-index-url", "--index", "--default-index", "--pip-args"],
};
const PM_COMMANDS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "pipx", "uv", "cargo", "go", "nix", "gem"]);
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node", "uv", "ruby", "perl", "php", "sh", "bash", "zsh", "java"]);
const RUN_WORDS = new Set(["run"]);
const INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "eval"]);
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|pl|php|sh|bash|zsh|jar|wasm)$/i;
const LAUNCHER_WORD = /(?:^|[\s/;|&])(?:npx|pnpx|bunx|uvx|pipx|dlx)(?:\s|$)/;
const EXACT_SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const EXACT_PEP440 = /^[0-9][0-9A-Za-z.+!_-]*$/;

function basename(command: string): string {
  return path.basename(command).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "");
}

function isInterpreter(base: string): boolean {
  return INTERPRETERS.has(base) || /^python(?:\d+(?:\.\d+)?)?$/.test(base);
}

/** `pkg@1.2.3`, `@scope/pkg@1.2.3`; a git, URL, file or tag spec is not an exact version. */
function exactNpm(spec: string): boolean {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return false;
  return EXACT_SEMVER.test(spec.slice(at + 1)) && !/[:#/]/.test(spec.slice(0, at).replace(/^@[^/]+\//, ""));
}

/** `pkg==1.2.3`, `pkg[extra]===1.2.3`, or uv's `pkg@1.2.3`; ranges and wildcards are not exact. */
function exactPypi(spec: string): boolean {
  const match = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?(?:===?|@)(.+)$/.exec(spec);
  return match !== null && EXACT_PEP440.test(match[1]!) && !match[1]!.includes("*");
}

type Refusal = Extract<McpArtifactResolution, { ok: false }>;

function unpinned(reason: string): Refusal {
  return { ok: false, code: "unpinned", reason };
}

function packagePin(eco: string, specs: readonly string[]): McpArtifactResolution {
  return { ok: true, pin: { kind: "package", digest: sha256(JSON.stringify(["package", eco, [...specs].sort()])) } };
}

function flagValue(args: readonly string[], i: number): [string | undefined, number] {
  const arg = args[i]!;
  const eq = arg.indexOf("=");
  if (arg.startsWith("--") && eq > 0) return [arg.slice(eq + 1), i];
  return [args[i + 1], i + 1];
}

function launcherPin(eco: Eco, args: readonly string[]): McpArtifactResolution {
  const specs: string[] = [];
  let packageFlag = false;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const flag = arg.split("=")[0]!;
    if (PACKAGE_FLAGS[eco].includes(flag)) {
      const [value, next] = flagValue(args, i);
      if (value !== undefined) specs.push(value);
      packageFlag = packageFlag || flag !== "--with";
      i = next;
    } else if (eco === "npm" && (flag === "-c" || flag === "--call")) {
      return unpinned("the launcher runs a shell string (-c); name the package with an exact version instead");
    } else if (VALUE_FLAGS[eco].includes(flag)) {
      i = flagValue(args, i)[1];
    } else if (!arg.startsWith("-")) {
      positional = arg;
      break; // everything after the package is the server's own argv
    }
  }
  if (!packageFlag && positional !== undefined) specs.push(positional);
  if (specs.length === 0) return unpinned("the launcher names no package; name it with an exact version");
  const exact = eco === "npm" ? exactNpm : exactPypi;
  const loose = specs.filter((spec) => !exact(spec));
  if (loose.length > 0) {
    const example = eco === "npm" ? "some-server@1.2.3" : "some-server==1.2.3";
    return unpinned(`${loose.length} package spec(s) name no exact version, so the code could change under the consent; pin each one (e.g. ${example})`);
  }
  return packagePin(eco, specs);
}

function imagePin(args: readonly string[]): McpArtifactResolution {
  if (args[0] !== "run") return unpinned("only `docker run <image>@sha256:<digest>` can be pinned");
  const image = args.find((arg) => /@sha256:[0-9a-f]{64}$/.test(arg));
  return image === undefined ? unpinned("the image is named by a tag, which can move; name it by its sha256 digest (image@sha256:...)") : packagePin("oci", [image]);
}

/** The executable a spawn of `command` would run, resolved like the OS does with the child's PATH. */
function whichCommand(command: string, cwd: string, pathVar: string | undefined): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    const full = path.resolve(cwd, command);
    return fs.existsSync(full) ? full : undefined;
  }
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, command);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The file itself (symlinks resolved), plus its package's package.json when it lives in node_modules. */
function pinnedFiles(file: string): string[] {
  const real = fs.realpathSync(file);
  const parts = real.split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return [real];
  const depth = parts[at + 1]!.startsWith("@") ? at + 3 : at + 2;
  const manifest = path.join(parts.slice(0, depth).join(path.sep) || path.sep, "package.json");
  return fs.existsSync(manifest) && manifest !== real ? [real, manifest] : [real];
}

function fingerprint(files: readonly string[]): string {
  return sha256(JSON.stringify(files.map((f) => {
    const s = fs.statSync(f, { bigint: true });
    return [f, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
  })));
}

function contentDigest(files: readonly string[]): string {
  return sha256(JSON.stringify(["file", files.map((f) => [f, sha256(fs.readFileSync(f))])]));
}

type FileSet = { readonly ok: true; readonly files: string[]; readonly inline?: false } | { readonly ok: true; readonly inline: true } | Refusal;

/** The script files an interpreter argv names: the first positional, and any argument with a code extension. */
function interpreterFiles(base: string, args: readonly string[], cwd: string): FileSet {
  const rest = RUN_WORDS.has(args[0] ?? "") && (base === "bun" || base === "deno" || base === "uv") ? args.slice(1) : args;
  const inline = rest.some((arg) => INLINE_FLAGS.has(arg));
  if (!inline && rest.includes("-m")) return unpinned("`-m` loads a module resolved at run time; name the script path, or use a pinned launcher (uvx some-server==1.2.3)");
  const files: string[] = [];
  let first = true;
  for (const arg of rest) {
    if (arg.startsWith("-")) continue;
    const candidate = path.resolve(cwd, arg);
    const isFile = fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    if (first && !inline && !isFile) return { ok: false, code: "unresolved", reason: `the script ${arg} was not found from ${cwd}` };
    if (isFile && (first || CODE_EXT.test(arg))) files.push(...pinnedFiles(candidate));
    first = false;
  }
  if (inline) return files.length > 0 ? { ok: true, files } : { ok: true, inline: true };
  if (files.length === 0) return unpinned("the interpreter is given no script file to pin");
  return { ok: true, files: [...new Set(files)] };
}

function filesFor(config: StdioConfig, options: McpArtifactOptions): FileSet | McpArtifactResolution {
  let command = config.command;
  let args = [...config.args];
  const env = { ...options.env, ...resolveTemplateRecord(config.env, options.env).values };
  // `env [VAR=value ...] command args` runs `command`: pin that.
  while (basename(command) === "env") {
    const at = args.findIndex((arg) => !arg.includes("=") && !arg.startsWith("-"));
    if (at < 0) return unpinned("`env` is given no command to run");
    command = args[at]!;
    args = args.slice(at + 1);
  }
  const base = basename(command);
  const launcher = LAUNCHERS.find(([name, sub]) => name === base && sub.every((word, i) => args[i] === word));
  if (launcher !== undefined) return launcherPin(launcher[2], args.slice(launcher[1].length));
  if (base === "docker" || base === "podman") return imagePin(args);
  if (args.some((arg) => LAUNCHER_WORD.test(arg) || /[@:]latest\b/.test(arg))) {
    return unpinned("the argv wraps a package launcher or a floating tag; launch it directly with an exact version");
  }
  if (isInterpreter(base)) return interpreterFiles(base, args, options.cwd);
  if (PM_COMMANDS.has(base)) return unpinned(`\`${base} ${args[0] ?? ""}\` resolves what it runs at run time; name the server's script or a pinned launcher`);
  const exe = whichCommand(command, options.cwd, env.PATH);
  if (exe === undefined) return { ok: false, code: "unresolved", reason: `the command ${command} was not found on the child's PATH` };
  return { ok: true, files: pinnedFiles(exe) };
}

/** What a consent records: the artifact pin, or why this launch spec cannot be pinned. */
export function resolveMcpArtifact(config: StdioConfig, options: McpArtifactOptions): McpArtifactResolution {
  let found: FileSet | McpArtifactResolution;
  try {
    found = filesFor(config, options);
  } catch (error) {
    return { ok: false, code: "unresolved", reason: `the launch artifact could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }
  if (!found.ok || "pin" in found) return found;
  if (found.inline === true) return { ok: true, pin: { kind: "inline", digest: sha256(JSON.stringify(["inline", config.command, config.args])) } };
  return { ok: true, pin: { kind: "file", digest: contentDigest(found.files), stat: fingerprint(found.files) } };
}

/** Before a spawn: does what would run now still match the consented pin? Fast when nothing changed. */
export function verifyMcpArtifact(config: StdioConfig, pin: McpArtifactPin, options: McpArtifactOptions): { ok: true } | { ok: false; reason: string } {
  const changed = { ok: false as const, reason: `the ${pin.kind === "package" ? "package spec" : "code"} it launches changed since consent (a possible rug pull)` };
  try {
    const found = filesFor(config, options);
    if (!found.ok) return { ok: false, reason: `${changed.reason}: ${found.reason}` };
    if ("pin" in found) return found.pin.digest === pin.digest ? { ok: true } : changed;
    if (found.inline === true) return pin.kind === "inline" && sha256(JSON.stringify(["inline", config.command, config.args])) === pin.digest ? { ok: true } : changed;
    if (pin.kind !== "file") return changed;
    if (pin.stat !== undefined && fingerprint(found.files) === pin.stat) return { ok: true };
    return contentDigest(found.files) === pin.digest ? { ok: true } : changed;
  } catch {
    return changed;
  }
}
