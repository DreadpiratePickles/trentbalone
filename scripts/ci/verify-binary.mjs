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
 *
 * Usage:  node scripts/ci/verify-binary.mjs <path-to-binary>
 * Exit:   0 all assertions passed, 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: node scripts/ci/verify-binary.mjs <path-to-binary>");
  process.exit(2);
}
const abs = path.resolve(bin);

const results = [];
let failed = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push(`PASS  ${name}${detail ? " - " + detail : ""}`);
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name} - ${err.message}`);
  }
}

function run(args, timeoutMs = 120_000) {
  const r = spawnSync(abs, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    env: {
      ...process.env,
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
    if (r.status !== 0) throw new Error(`exit ${r.status}; output: ${out.slice(0, 400)}`);
    const m = out.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
    if (!m) throw new Error(`no semver in output: ${JSON.stringify(out.slice(0, 200))}`);
    return `${m[0]} (exit 0)`;
  });

  check("`trent doctor --json` emits one parseable JSON document", () => {
    const r = run(["doctor", "--json"]);
    const out = r.stdout.trim();
    if (!out) throw new Error(`empty stdout; stderr: ${r.stderr.trim().slice(0, 400)}`);

    let doc;
    try {
      doc = JSON.parse(out);
    } catch (e) {
      // Tolerate a leading banner only if the JSON is still isolable; anything else is a
      // real defect, because --json output must be pipeable into jq.
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error(`unparseable: ${e.message}; got: ${JSON.stringify(out.slice(0, 300))}`);
      doc = JSON.parse(out.slice(start, end + 1));
      if (start !== 0) throw new Error("--json emitted non-JSON preamble; output is not pipeable");
    }

    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      throw new Error("doctor --json must be a JSON object");
    }
    const checks = doc.checks ?? doc.results ?? doc.report?.checks;
    if (!Array.isArray(checks)) throw new Error(`no checks array in doctor output; keys: ${Object.keys(doc).join(",")}`);
    if (checks.length === 0) throw new Error("doctor reported zero checks - a doctor that inspects nothing always looks green");
    const withStatus = checks.filter((c) => c && typeof c.status === "string");
    if (withStatus.length !== checks.length) throw new Error("every check must carry a string `status`");
    return `${checks.length} checks, doctor exit ${r.status}`;
  });
}

const header = `verify-binary: ${abs}\nplatform: ${process.platform}/${process.arch}\n`;
const body = results.join("\n");
process.stdout.write(header + body + "\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Ran binary on ${process.platform}/${process.arch}\n\n\`\`\`\n${header}${body}\n\`\`\`\n`,
  );
}

process.exit(failed === 0 ? 0 : 1);
