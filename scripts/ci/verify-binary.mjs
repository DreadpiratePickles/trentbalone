#!/usr/bin/env node
/**
 * verify-binary.mjs — EXECUTE a compiled Trent binary on the operating system it targets.
 *
 * This script is the whole reason CI exists for this project. A cross-compiled binary that
 * exits 0 at build time proves nothing: a native module once cross-compiled successfully and
 * emitted a Linux ELF containing macOS headers. Compile success is not evidence. Running the
 * artifact on its real OS is.
 *
 * It asserts:
 *   1. the binary is executable and starts at all (no dynamic-loader / bad-arch failure);
 *   2. `trent --version` prints something semver-shaped on stdout;
 *   3. `trent doctor --json` prints ONE parseable JSON document with the expected shape.
 *      doctor is allowed a non-zero exit — it exits non-zero when a check fails, by design —
 *      but it is NOT allowed to emit unparseable output, and it is not allowed to emit a
 *      document with zero checks (that is how a doctor that inspects nothing looks green).
 *   4. `trent --help` exits 0 and lists the command surface;
 *   5. `trent fleet list --json` and `trent improve status --json` each exit 0 with one JSON
 *      object on stdout. These exercise the fleet / self-improvement module graphs, which
 *      is where import-time side effects that only bite inside the compiled bundle live.
 *   6. From an EMPTY scratch directory with an empty TRENT_HOME and no provider key anywhere:
 *      `trent run "..." --json` prints ONE JSON result object (no `[Worker]` or pino preamble),
 *      reaches a verdict (a workspace without `.claude/skills` is zero skills, not ENOENT), and
 *      leaves a durable `trent.db` holding the derived schema (the DDL is embedded; before it
 *      was read off a path that does not exist inside the binary, so no binary was ever durable).
 *   7. From a scratch directory holding `.env.local` with `GEMINI_API_KEY=fake`: the doctor's
 *      credentials check does NOT see that key. A standalone Bun executable autoloads `.env*`
 *      from its cwd unless built with `--no-compile-autoload-dotenv`
 *      (https://bun.sh/docs/bundler/executables); a user's project file must never become
 *      Trent's provider key.
 *
 * On failure the FULL stderr of the command is printed, not a one-line excerpt. A compiled
 * bundle reports crashes as a source-context frame ("43761 |     if (t !== undefined)")
 * followed by the actual error several lines later; truncating to the first line made a
 * Prisma engine-not-found crash undiagnosable from CI for a whole run.
 *
 * Usage:  node scripts/ci/verify-binary.mjs <path-to-binary>
 * Exit:   0 all assertions passed, 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: node scripts/ci/verify-binary.mjs <path-to-binary>");
  process.exit(2);
}
const abs = path.resolve(bin);

const results = [];
const failures = [];
let failed = 0;

/** Error carrying the whole captured output of the command that failed the assertion. */
class CommandFailure extends Error {
  constructor(message, r) {
    super(message);
    this.stdout = r?.stdout ?? "";
    this.stderr = r?.stderr ?? "";
    this.status = r?.status;
  }
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push(`PASS  ${name}${detail ? " - " + detail : ""}`);
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name} - ${err.message}`);
    if (err instanceof CommandFailure) failures.push({ name, err });
  }
}

/** Stdout must be exactly one JSON object (a leading banner makes --json unpipeable). */
function parseJsonObject(r, what) {
  const out = r.stdout.trim();
  if (!out) throw new CommandFailure(`empty stdout (exit ${r.status}); see full stderr below`, r);
  let doc;
  try {
    doc = JSON.parse(out);
  } catch (e) {
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start === -1 || end <= start) throw new CommandFailure(`unparseable: ${e.message}`, r);
    doc = JSON.parse(out.slice(start, end + 1));
    if (start !== 0) throw new CommandFailure(`${what} emitted non-JSON preamble; output is not pipeable`, r);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new CommandFailure(`${what} must be a JSON object`, r);
  }
  return doc;
}

function run(args, timeoutMs = 120_000, options = {}) {
  const r = spawnSync(abs, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: {
      ...(options.env ?? process.env),
      // The standalone environment contract. Without the first line every job runs twice and
      // still reports success (~4x the model bill, silently) — see AGENTS.md.
      TRENT_QUEUE_FALLBACK: "disabled",
      NO_COLOR: "1",
      CI: "1",
    },
  });
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`);
  if (r.signal) throw new Error(`killed by signal ${r.signal} (timeout ${timeoutMs}ms?)`);
  return r;
}

/** Looks like a provider credential: never let the CI host's own keys reach a scratch run. */
const CREDENTIAL_RE = /(API_KEY|_TOKEN|_SECRET|PASSWORD)/i;

/** A scratch home and cwd, with every credential-shaped variable stripped from the environment. */
function scratch(label) {
  const home = mkdtempSync(path.join(tmpdir(), `trent-verify-${label}-home-`));
  const cwd = mkdtempSync(path.join(tmpdir(), `trent-verify-${label}-cwd-`));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !CREDENTIAL_RE.test(k)));
  env.TRENT_HOME = home;
  delete env.TRENT_PROFILE;
  delete env.DATABASE_URL;
  // Windows: the binary's SQLite and lock handles can outlive its exit by a few hundred ms, and an
  // immediate rmdir then fails with EBUSY (seen twice in CI on 2026-09-25). Node retries these.
  // The retries were not enough on 2026-09-25 either (the runner's file scanner can hold a fresh
  // file past the window), and every assertion has already passed by the time dispose runs, so a
  // scratch dir that cannot be removed is a warning, never a failed job.
  const rm = (dir) => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (err) {
      console.warn(`warn: could not remove scratch dir ${dir}: ${err?.code ?? err}`);
    }
  };
  return { home, cwd, env, dispose: () => { rm(home); rm(cwd); } };
}

/** The table names of a SQLite file, through node:sqlite so no sqlite3 CLI is needed on the runner. */
async function tableNames(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  } finally {
    db.close();
  }
}

/** `check` for an assertion that needs to await. */
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push(`PASS  ${name}${detail ? " - " + detail : ""}`);
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name} - ${err.message}`);
    if (err instanceof CommandFailure) failures.push({ name, err });
  }
}

check("artifact exists and is non-empty", () => {
  if (!existsSync(abs)) throw new Error(`no file at ${abs}`);
  const size = statSync(abs).size;
  if (size < 1024) throw new Error(`suspiciously small: ${size} bytes`);
  return `${size} bytes`;
});

if (failed === 0) {
  check("`trent --version` runs on this OS and prints a version", () => {
    const r = run(["--version"]);
    const out = (r.stdout + r.stderr).trim();
    if (r.status !== 0) throw new CommandFailure(`exit ${r.status}`, r);
    const m = out.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
    if (!m) throw new CommandFailure(`no semver in output: ${JSON.stringify(out.slice(0, 200))}`, r);
    return `${m[0]} (exit 0)`;
  });

  check("`trent doctor --json` emits one parseable JSON document", () => {
    const r = run(["doctor", "--json"]);
    const doc = parseJsonObject(r, "doctor --json");
    const checks = doc.checks ?? doc.results ?? doc.report?.checks;
    if (!Array.isArray(checks)) throw new CommandFailure(`no checks array in doctor output; keys: ${Object.keys(doc).join(",")}`, r);
    if (checks.length === 0) throw new CommandFailure("doctor reported zero checks - a doctor that inspects nothing always looks green", r);
    const withStatus = checks.filter((c) => c && typeof c.status === "string");
    if (withStatus.length !== checks.length) throw new CommandFailure("every check must carry a string `status`", r);
    return `${checks.length} checks, doctor exit ${r.status}`;
  });

  check("`trent --help` exits 0 and lists commands", () => {
    const r = run(["--help"]);
    if (r.status !== 0) throw new CommandFailure(`exit ${r.status}`, r);
    const out = r.stdout;
    if (!/Usage:/.test(out)) throw new CommandFailure("no 'Usage:' line in --help stdout", r);
    for (const cmd of ["doctor", "fleet", "improve"]) {
      if (!new RegExp(`^\\s+${cmd}\\b`, "m").test(out)) throw new CommandFailure(`--help does not list the '${cmd}' command`, r);
    }
    return "exit 0";
  });

  check("`trent fleet list --json` exits 0 with one JSON object", () => {
    const r = run(["fleet", "list", "--json"]);
    if (r.status !== 0) throw new CommandFailure(`exit ${r.status}`, r);
    const doc = parseJsonObject(r, "fleet list --json");
    if (!Array.isArray(doc.agents)) throw new CommandFailure(`no agents array; keys: ${Object.keys(doc).join(",")}`, r);
    if (doc.agents.length === 0) throw new CommandFailure("fleet list reported zero agents - the bundled catalog did not load", r);
    return `${doc.agents.length} agents`;
  });

  check("`trent improve status --json` exits 0 with one JSON object", () => {
    const r = run(["improve", "status", "--json"]);
    if (r.status !== 0) throw new CommandFailure(`exit ${r.status}`, r);
    const doc = parseJsonObject(r, "improve status --json");
    if (typeof doc.companyId !== "string") throw new CommandFailure(`no companyId; keys: ${Object.keys(doc).join(",")}`, r);
    return `companyId ${doc.companyId}`;
  });

  await checkAsync("`trent run --json` from an empty directory: one JSON document, a verdict, a durable trent.db", async () => {
    const s = scratch("run");
    try {
      // No key anywhere, so the run cannot reach a model; it must still reach the gateway and say so.
      const r = run(["run", "say hi", "--json"], 120_000, { cwd: s.cwd, env: s.env });
      const doc = parseJsonObject(r, "run --json");
      if (doc.type !== "result") throw new CommandFailure(`stdout is not the result object; keys: ${Object.keys(doc).join(",")}`, r);
      if (doc.error === "the run ended without a verdict") {
        throw new CommandFailure("the run ended without a verdict: the first seat step died before the gateway (a missing .claude/skills used to do this)", r);
      }
      const db = path.join(s.home, "trent.db");
      if (!existsSync(db)) throw new CommandFailure(`no durable store: ${db} was not created (the store fell back to memory)`, r);
      const tables = await tableNames(db);
      if (!tables.includes("OrchestratorRun")) throw new CommandFailure(`trent.db has no OrchestratorRun table; tables: ${tables.join(",") || "<none>"}`, r);
      return `exit ${r.status}, status ${doc.status}, ${tables.length} tables, stderr ${Buffer.byteLength(r.stderr)} bytes`;
    } finally {
      s.dispose();
    }
  });

  check("a project `.env.local` in the cwd never becomes Trent's provider key", () => {
    const s = scratch("dotenv");
    try {
      writeFileSync(path.join(s.cwd, ".env.local"), "GEMINI_API_KEY=fake\n");
      const r = run(["doctor", "--json"], 120_000, { cwd: s.cwd, env: s.env });
      const doc = parseJsonObject(r, "doctor --json");
      const checks = doc.checks ?? doc.results ?? [];
      const cred = checks.find((c) => c && c.id === "check_credentials" || (c && c.name === "API Credentials"));
      if (!cred) throw new CommandFailure("doctor did not report the credentials check", r);
      const leaked = cred.details?.keyLength !== undefined || /not a usable/.test(String(cred.message));
      if (leaked) throw new CommandFailure(`the cwd's .env.local reached the credentials check: ${cred.message}`, r);
      return `credentials: ${cred.status} (${String(cred.message).slice(0, 80)})`;
    } finally {
      s.dispose();
    }
  });

  check("a workspace without .claude/skills is reported by the doctor, not fatal", () => {
    const s = scratch("skills");
    try {
      if (readdirSync(s.cwd).length !== 0) throw new Error("scratch cwd is not empty");
      mkdirSync(path.join(s.cwd, "nothing-here"));
      const r = run(["doctor", "--json"], 120_000, { cwd: s.cwd, env: s.env });
      const doc = parseJsonObject(r, "doctor --json");
      const checks = doc.checks ?? doc.results ?? [];
      const skills = checks.find((c) => c && c.id === "check_skills" || (c && c.name === "Skills Hub"));
      if (!skills) throw new CommandFailure("doctor did not report the skills check", r);
      if (!/no \.claude\/skills/.test(String(skills.message))) throw new CommandFailure(`no workspace note: ${skills.message}`, r);
      return String(skills.message).slice(0, 100);
    } finally {
      s.dispose();
    }
  });
}

const header = `verify-binary: ${abs}\nplatform: ${process.platform}/${process.arch}\n`;
const body = results.join("\n");
process.stdout.write(header + body + "\n");

// Full, untruncated output of every failed command. This is the part that turns "empty
// stdout" into a diagnosis.
for (const { name, err } of failures) {
  const block = (label, text) =>
    `----- ${label} (${Buffer.byteLength(text)} bytes) -----\n${text.trimEnd() || "<empty>"}\n`;
  process.stdout.write(
    `\n===== FULL OUTPUT: ${name} (exit ${err.status}) =====\n` +
      block("stdout", err.stdout) +
      block("stderr", err.stderr) +
      `===== END ${name} =====\n`,
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Ran binary on ${process.platform}/${process.arch}\n\n\`\`\`\n${header}${body}\n\`\`\`\n`,
  );
}

process.exit(failed === 0 ? 0 : 1);
