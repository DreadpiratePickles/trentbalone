#!/usr/bin/env node --test
/**
 * minisign-key-format.test.mjs — what `gen-keys.mjs` writes, and what the release shim does to it.
 *
 *   node --test scripts/ci/minisign-key-format.test.mjs
 *
 * `scripts/installer/keys/README.md` claims real `minisign` reads the generated secret key without
 * prompting, i.e. kdf_alg = "\0\0" (what `minisign -G -W` writes). An earlier revision wrote "Sc"
 * with opslimit 0, which minisign 0.12 treats as encrypted; `scripts/release/minisign-plain-key.mjs`
 * was added to rewrite those two bytes and `release.yml` still runs it on the CI secret, which may
 * have been captured from such a key. This test is the executable form of both claims: the README
 * headline is true today, and the shim is a byte-exact pass-through for a key that is already
 * plain, so running it unconditionally cannot corrupt a good key.
 *
 * Every key here is generated into a throwaway directory and never printed; the repository's own
 * private keys are not read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const KEYS = path.join(REPO_ROOT, "scripts/installer/keys");
const SHIM = path.join(REPO_ROOT, "scripts/release/minisign-plain-key.mjs");

/** Run gen-keys.mjs in a scratch directory: it writes next to itself, never into the repo. */
function generateInScratch() {
  const work = mkdtempSync(path.join(tmpdir(), "minisign-fmt-"));
  for (const f of ["gen-keys.mjs", "blake2b.mjs"]) cpSync(path.join(KEYS, f), path.join(work, f));
  execFileSync(process.execPath, [path.join(work, "gen-keys.mjs")], { stdio: "pipe" });
  return work;
}

const payload = (file) => Buffer.from(readFileSync(file, "utf8").split("\n")[1], "base64");

function runShim(input, output) {
  return execFileSync(process.execPath, [SHIM, input, output], { encoding: "utf8", stdio: "pipe" });
}

test("gen-keys.mjs writes minisign's unencrypted layout, so real minisign never prompts", () => {
  const work = generateInScratch();
  try {
    const raw = payload(path.join(work, "minisign.key"));
    assert.equal(raw.length, 158);
    assert.equal(raw.subarray(0, 2).toString(), "Ed");
    assert.equal(raw.subarray(2, 4).toString("latin1"), "\0\0", "kdf_alg is not the unencrypted marker");
    assert.equal(raw.subarray(4, 6).toString(), "B2");
    assert.equal(raw.readBigUInt64LE(38), 0n);
    assert.equal(raw.readBigUInt64LE(46), 0n);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the release shim is a byte-exact pass-through for a key that is already plain", () => {
  const work = generateInScratch();
  try {
    const src = path.join(work, "minisign.key");
    const out = path.join(work, "plain.key");
    runShim(src, out);
    assert.deepEqual(payload(out), payload(src));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shim still converts a pre-fix 'Sc' key, changing exactly the two kdf bytes", () => {
  const work = generateInScratch();
  try {
    const src = path.join(work, "minisign.key");
    const raw = payload(src);
    const legacy = Buffer.from(raw);
    legacy.write("Sc", 2, "latin1"); // what gen-keys.mjs wrote before e65d88a
    const legacyFile = path.join(work, "legacy.key");
    writeFileSync(legacyFile, `untrusted comment: legacy\n${legacy.toString("base64")}\n`);
    const out = path.join(work, "converted.key");
    runShim(legacyFile, out);
    const got = payload(out);
    assert.equal(got.subarray(2, 4).toString("latin1"), "\0\0");
    assert.deepEqual(got.subarray(4), raw.subarray(4), "the shim touched more than kdf_alg");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("real minisign signs with a freshly generated key without prompting for a password", (t) => {
  let minisign;
  try {
    minisign = execFileSync("/usr/bin/env", ["which", "minisign"], { encoding: "utf8" }).trim();
  } catch {
    return t.skip("minisign is not installed on this machine (CI installs it in the sign job)");
  }
  const work = generateInScratch();
  try {
    const msg = path.join(work, "SHA256SUMS");
    writeFileSync(msg, "0".repeat(64) + "  trent-linux-x64\n");
    const sig = path.join(work, "SHA256SUMS.minisig");
    // stdin closed: a password prompt cannot be answered, so a prompting key fails here.
    execFileSync(minisign, ["-S", "-s", path.join(work, "minisign.key"), "-m", msg, "-x", sig], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync(minisign, ["-V", "-p", path.join(work, "minisign.pub"), "-m", msg, "-x", sig], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the shim refuses a genuinely password-protected key instead of mangling it", () => {
  const work = generateInScratch();
  try {
    const raw = payload(path.join(work, "minisign.key"));
    const encrypted = Buffer.from(raw);
    encrypted.write("Sc", 2, "latin1");
    encrypted.writeBigUInt64LE(33554432n, 38); // a real opslimit: the bytes are not in clear
    const file = path.join(work, "encrypted.key");
    writeFileSync(file, `untrusted comment: encrypted\n${encrypted.toString("base64")}\n`);
    assert.throws(
      () => runShim(file, path.join(work, "nope.key")),
      (err) => err.status === 1 && /password-protected/.test(String(err.stderr)),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
