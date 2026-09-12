#!/usr/bin/env node
/**
 * live-tests-gate.mjs — decide whether provider-key tests run, and make an absent key
 * report as SKIPPED, never as PASSED.
 *
 * The failure mode this prevents: a suite that silently no-ops when ANTHROPIC_API_KEY is
 * unset, exits 0, and shows a green tick. A green tick that proves nothing is worse than a
 * red one, because it stops anyone looking.
 *
 * How it works: this script only computes an output. The job that actually runs the live
 * tests is guarded by `if: needs.live-gate.outputs.should_run == 'true'`, so when a key is
 * absent GitHub marks that job **Skipped** (grey) rather than Success (green).
 *
 * TRENT_REQUIRE_LIVE_TESTS=1 flips the polarity: a missing key then FAILS this gate, so the
 * nightly schedule cannot quietly degrade into a no-op build.
 *
 * Usage:  node scripts/ci/live-tests-gate.mjs
 * Env:    TRENT_REQUIRE_LIVE_TESTS, plus the provider keys below.
 * Output: should_run=true|false and present_keys=... on $GITHUB_OUTPUT.
 */

import { appendFileSync } from "node:fs";

/** Keys the live suites can use. `required` = needed for the minimum live run. */
const PROVIDER_KEYS = [
  { name: "ANTHROPIC_API_KEY", required: true },
  { name: "OPENAI_API_KEY", required: false },
  { name: "GOOGLE_API_KEY", required: false },
];

const require_live = /^(1|true|yes)$/i.test(process.env.TRENT_REQUIRE_LIVE_TESTS ?? "");

// Presence only. The VALUE is never printed, logged or written to a summary.
const present = PROVIDER_KEYS.filter((k) => (process.env[k.name] ?? "").trim().length > 0);
const missingRequired = PROVIDER_KEYS.filter((k) => k.required && !present.some((p) => p.name === k.name));

const shouldRun = missingRequired.length === 0;

const lines = [
  `TRENT_REQUIRE_LIVE_TESTS = ${require_live ? "1 (live tests are MANDATORY)" : "unset (live tests are optional)"}`,
  `provider keys present: ${present.length ? present.map((k) => k.name).join(", ") : "(none)"}`,
  `missing required: ${missingRequired.length ? missingRequired.map((k) => k.name).join(", ") : "(none)"}`,
  "",
];

if (shouldRun) {
  lines.push("RESULT: live provider tests WILL RUN.");
} else if (require_live) {
  lines.push("RESULT: FAIL. TRENT_REQUIRE_LIVE_TESTS is set but a required provider key is absent.");
  lines.push("A run that cannot reach a provider must not report success.");
} else {
  lines.push("RESULT: live provider tests are SKIPPED (no provider key configured).");
  lines.push("The downstream job is `if:`-gated, so GitHub marks it Skipped, not Success.");
  lines.push("This is deliberate: an unproven capability must never render as a green tick.");
}

const text = lines.join("\n");
process.stdout.write(text + "\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Live provider tests\n\n\`\`\`\n${text}\n\`\`\`\n`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `should_run=${shouldRun}\npresent_keys=${present.map((k) => k.name).join(",")}\n`,
  );
}

process.exit(!shouldRun && require_live ? 1 : 0);
