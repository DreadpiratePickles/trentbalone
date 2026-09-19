/**
 * The two sections of `trent security audit` that read the disk rather than the config object:
 * the file modes under the profile directory, and whether `config.yaml` is holding a credential.
 *
 * Split out of `security-audit.ts` to keep both files under the 500-line rule. Nothing here is
 * reachable except through `auditProfileSecurity`, and neither function writes.
 *
 * The permission rules are the table in `docs/security.md`, "File permissions", read back from the
 * real files: `.env` and the audit keys are critical because they ARE the credentials, the session
 * transcripts and the store are high because they are what the model was told, and the directories
 * are medium because `SESSION_DIR_MODE` is documented as best effort on mounts that cannot chmod.
 *
 * The config scan reports a KEY and a line number and never a value, and skips two things on
 * purpose: the 40-character alphanumeric detector, which matches every git SHA and content hash,
 * and any value that is exactly a `${VAR}` reference, which is resolved at connect time and never
 * stored. A section that cried wolf on those would teach its reader to skip it.
 */
import fs from "node:fs";
import path from "node:path";
// The doctor already owns "what mode must the secrets file have"; it is not restated here.
import { SECRETS_FILE_MODE } from "../doctor/FixRunner.js";
import { SESSION_DIR_MODE, SESSION_FILE_MODE } from "../sessions/SessionStore.js";
import { secretDetectors } from "../telemetry/redact.js";
import { WORKSPACE_TRUST_FILE, WORKSPACE_TRUST_FILE_MODE } from "../workspace-context/trust.js";
import type { SecurityAuditCollector, SecurityAuditInput, SecuritySeverity } from "./security-audit.js";

/** `0o644` as `"644"`, for a message a reader can compare with what `ls -l` showed them. */
export function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

// ----------------------------------------------------------- file permissions

interface PrivateRule {
  readonly what: string;
  readonly mode: number;
  readonly severity: SecuritySeverity;
}

/** What a path under the profile directory is, when it is something only this user may read. */
function privateFileRule(rel: string): PrivateRule | null {
  const base = path.posix.basename(rel);
  if (base === ".env") return { what: "the profile's secrets file", mode: SECRETS_FILE_MODE, severity: "critical" };
  if (base === "hooks-consent.json") return { what: "the hook consent record", mode: 0o600, severity: "high" };
  if (base === WORKSPACE_TRUST_FILE) return { what: "the workspace trust record", mode: WORKSPACE_TRUST_FILE_MODE, severity: "high" };
  if (rel.startsWith("keys/")) return { what: "an audit signing key", mode: 0o600, severity: "critical" };
  if (rel.startsWith("egress/") && (base === "ca.key" || base === "tokens.json")) {
    return { what: "egress interception material", mode: 0o600, severity: "critical" };
  }
  if (rel.startsWith("sessions/") && base.endsWith(".json")) {
    return { what: "a stored session transcript", mode: SESSION_FILE_MODE, severity: "high" };
  }
  if (/\.db(-wal|-shm)?$/.test(base)) return { what: "the durable store", mode: 0o600, severity: "high" };
  return null;
}

const PRIVATE_DIRS: Readonly<Record<string, PrivateRule>> = {
  keys: { what: "the audit key directory", mode: 0o700, severity: "high" },
  sessions: { what: "the sessions directory", mode: SESSION_DIR_MODE, severity: "medium" },
  egress: { what: "the egress material directory", mode: 0o700, severity: "high" },
};

const MAX_WALK_DEPTH = 6;
const MAX_WALK_ENTRIES = 5000;

export function auditFilePermissions(input: SecurityAuditInput, out: SecurityAuditCollector): void {
  const problems: Array<{ path: string; mode: string; expected: string; what: string }> = [];
  let checked = 0;
  let seen = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || seen > MAX_WALK_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      seen += 1;
      if (seen > MAX_WALK_ENTRIES) return;
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const full = path.join(dir, entry.name);
      let mode: number;
      try {
        mode = fs.statSync(full).mode & 0o777;
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        const dirRule = PRIVATE_DIRS[childRel];
        if (dirRule !== undefined) {
          checked += 1;
          if ((mode & ~dirRule.mode & 0o777) !== 0) {
            problems.push({ path: childRel, mode: octal(mode), expected: octal(dirRule.mode), what: dirRule.what });
            out.finding({
              id: "profile-file-too-permissive",
              section: "file-permissions",
              severity: dirRule.severity,
              message: `${childRel} is mode 0${octal(mode)}; ${dirRule.what} must be 0${octal(dirRule.mode)} (no group or other permission)`,
              fix: `chmod ${octal(dirRule.mode)} ${full}`,
            });
          }
        }
        walk(full, childRel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const rule = privateFileRule(childRel);
      if (rule === null) continue;
      checked += 1;
      if ((mode & 0o077) === 0) continue;
      problems.push({ path: childRel, mode: octal(mode), expected: octal(rule.mode), what: rule.what });
      out.finding({
        id: "profile-file-too-permissive",
        section: "file-permissions",
        severity: rule.severity,
        message: `${childRel} is mode 0${octal(mode)}; ${rule.what} must be 0${octal(rule.mode)} (no group or other permission)`,
        fix: `chmod ${octal(rule.mode)} ${full}`,
      });
    }
  };

  walk(input.profileDir, "", 0);
  out.section("file-permissions", "File permissions under the profile", {
    root: input.profileDir,
    checked,
    problems,
  });
}

// --------------------------------------------------------------- config secrets

/**
 * The one detector deliberately not applied: any 40-character alphanumeric run. A git SHA, a
 * content hash and a container digest all match it, and a report that cried wolf on every hash
 * would teach its reader to ignore the section. Same reasoning as `tools/mcp/scan.ts`.
 */
const SKIPPED_DETECTORS: ReadonlySet<string> = new Set(["base64-run"]);

/** `${VAR}` is a reference resolved at connect time; the value is never stored here. */
const ENV_REFERENCE = /^["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?$/;

export function auditConfigSecrets(input: SecurityAuditInput, out: SecurityAuditCollector): void {
  let body: string;
  try {
    body = fs.readFileSync(input.configPath, "utf8");
  } catch {
    out.section("config-secrets", "Secrets in config.yaml", { configFile: input.configPath, exists: false, scanned: 0, keys: [] });
    return;
  }

  const detectors = secretDetectors().filter((detector) => !SKIPPED_DETECTORS.has(detector.name));
  const hits: Array<{ line: number; key: string; detector: string }> = [];
  const lines = body.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const colon = trimmed.indexOf(":");
    if (colon < 0) return;
    const key = trimmed.slice(0, colon).replace(/^-\s*/, "").trim();
    const value = trimmed.slice(colon + 1).trim();
    if (value === "" || ENV_REFERENCE.test(value)) return;

    for (const detector of detectors) {
      const re = new RegExp(detector.pattern.source, detector.pattern.flags.replace("g", ""));
      if (!re.test(line)) continue;
      hits.push({ line: index + 1, key, detector: detector.name });
      return;
    }
  });

  out.section("config-secrets", "Secrets in config.yaml", {
    configFile: input.configPath,
    exists: true,
    scanned: lines.length,
    detectors: detectors.map((detector) => detector.name),
    keys: hits.map((hit) => ({ line: hit.line, key: hit.key, detector: hit.detector })),
  });

  for (const hit of hits) {
    out.finding({
      id: "secret-in-config-yaml",
      section: "config-secrets",
      severity: "critical",
      message: `config.yaml line ${hit.line} holds a value under "${hit.key}" that matches the ${hit.detector} detector; config.yaml is mode 0644 and secrets belong in .env`,
      fix: `delete that line from config.yaml and put the value in ${input.secretsPath} (mode 0600); trent config set ${hit.key.toUpperCase()} <value> writes a credential there`,
    });
  }
}
