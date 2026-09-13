/**
 * The environment a local child process may inherit. Ported from Hermes
 * `tools/code_execution_env.py:24-49`: a secret-substring BLOCK first, then an allowlist of safe
 * prefixes and exact operational names. Allowlist, not denylist: a variable that matches nothing
 * is dropped. `TRENT_PROXY_TOKEN` and caller-supplied values are added by the caller afterwards.
 */

const SAFE_PREFIXES = ["PATH", "HOME", "USER", "LANG", "LC_", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL",
  "LOGNAME", "XDG_", "PYTHONPATH", "VIRTUAL_ENV", "CONDA", "PWD", "COLORTERM", "EDITOR", "NODE_ENV"] as const;

/** "PASS" is deliberately absent (BYPASS_CACHE, COMPASS_DIR); PASSWORD/PASSWD cover credentials. */
export const SECRET_SUBSTRINGS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH", "DSN",
  "WEBHOOK", "CREDS", "BEARER", "APIKEY"] as const;

const TRENT_CHILD_ALLOWED = new Set(["TRENT_HOME", "TRENT_PROFILE", "TRENT_CONFIG", "TRENT_QUEUE_FALLBACK"]);

export function isSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return SECRET_SUBSTRINGS.some((needle) => upper.includes(needle));
}

export function scrubChildEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretName(name)) continue;
    const upper = name.toUpperCase();
    if (SAFE_PREFIXES.some((prefix) => upper.startsWith(prefix)) || TRENT_CHILD_ALLOWED.has(upper)) out[name] = value;
  }
  return out;
}
