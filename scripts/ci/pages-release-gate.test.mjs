#!/usr/bin/env node --test
/**
 * pages-release-gate.test.mjs — the Pages deploy must not serve an installer that cannot install.
 *
 *   node --test scripts/ci/pages-release-gate.test.mjs
 *
 * `scripts/install.sh` has no pinned version: it resolves `.../releases/latest` at run time and
 * fails at `resolve-version` when that redirect does not exist. `pages.yml` also triggers on a push
 * to `main` touching the installers, which can happen before any release is published, so the site
 * would advertise a one-curl install that 404s. These tests pin the gate's decision table AND the
 * fact that `pages.yml` is actually wired to it — a gate nothing consults is decoration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const GATE = path.join(HERE, "pages-release-gate.mjs");
const WORKFLOW = path.join(REPO_ROOT, ".github/workflows/pages.yml");

const { decideServe } = await import(GATE);

const stable = { tag_name: "v1.0.0", draft: false, prerelease: false };
const draft = { tag_name: "v1.0.0", draft: true, prerelease: false };
const pre = { tag_name: "v1.0.0-rc.1", draft: false, prerelease: true };

test("a published stable release lets the site serve the installer", () => {
  const d = decideServe({ eventName: "release", releases: [stable] });
  assert.equal(d.serve, true);
  assert.match(d.reason, /v1\.0\.0/);
});

test("a push to main with no release at all refuses to deploy", () => {
  const d = decideServe({ eventName: "push", releases: [] });
  assert.equal(d.serve, false);
  assert.match(d.reason, /releases\/latest/);
});

test("a draft release is not a release the installer can resolve", () => {
  assert.equal(decideServe({ eventName: "push", releases: [draft] }).serve, false);
});

test("a prerelease alone is refused, because releases/latest skips prereleases", () => {
  const d = decideServe({ eventName: "release", releases: [pre] });
  assert.equal(d.serve, false);
  assert.match(d.reason, /prerelease/i);
});

test("a stable release alongside a draft and a prerelease is enough", () => {
  assert.equal(decideServe({ eventName: "push", releases: [draft, pre, stable] }).serve, true);
});

test("the documented dispatch override serves before any release exists", () => {
  const d = decideServe({ eventName: "workflow_dispatch", releases: [], allowWithoutRelease: true });
  assert.equal(d.serve, true);
  assert.match(d.reason, /allow_without_release/);
});

test("the override does not apply to a push, which is not a human decision", () => {
  assert.equal(decideServe({ eventName: "push", releases: [], allowWithoutRelease: true }).serve, false);
});

test("the CLI writes serve= and reason= to GITHUB_OUTPUT and still exits 0 when it refuses", () => {
  const work = mkdtempSync(path.join(tmpdir(), "pages-gate-"));
  try {
    const releases = path.join(work, "releases.json");
    const out = path.join(work, "gh-output");
    writeFileSync(releases, "[]");
    writeFileSync(out, "");
    const stdout = execFileSync(process.execPath, [GATE, releases], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: out },
    });
    const written = readFileSync(out, "utf8");
    assert.match(written, /^serve=false$/m);
    assert.match(written, /^reason=.+$/m);
    assert.match(stdout, /refus/i);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the CLI fails loudly rather than silently refusing when the release list is unreadable", () => {
  const work = mkdtempSync(path.join(tmpdir(), "pages-gate-"));
  try {
    const releases = path.join(work, "releases.json");
    writeFileSync(releases, "not json");
    assert.throws(
      () =>
        execFileSync(process.execPath, [GATE, releases], {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_OUTPUT: "" },
        }),
      (err) => err.status === 2,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("pages.yml consults the gate and skips build and deploy when it refuses", () => {
  const wf = YAML.parse(readFileSync(WORKFLOW, "utf8"));
  const gate = wf.jobs.gate;
  assert.ok(gate, "pages.yml has no `gate` job");
  assert.equal(gate.outputs.serve, "${{ steps.gate.outputs.serve }}");
  const runsGate = JSON.stringify(gate.steps).includes("scripts/ci/pages-release-gate.mjs");
  assert.ok(runsGate, "the gate job does not run scripts/ci/pages-release-gate.mjs");
  for (const name of ["build", "deploy"]) {
    const job = wf.jobs[name];
    assert.ok([].concat(job.needs).includes("gate"), `job ${name} does not need the gate`);
    assert.equal(job.if, "needs.gate.outputs.serve == 'true'", `job ${name} is not gated`);
  }
  // The escape hatch the gate documents must exist as a real dispatch input.
  assert.ok(wf.on.workflow_dispatch.inputs.allow_without_release, "no allow_without_release input");
});
