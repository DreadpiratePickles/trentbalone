#!/usr/bin/env node
// minisign-plain-key.mjs — rewrite a stored-in-clear minisign secret key into the format the
// real `minisign` binary reads WITHOUT prompting for a password.
//
//   node scripts/release/minisign-plain-key.mjs <in.key> <out.key>
//
// Why: `scripts/installer/keys/gen-keys.mjs` writes the secret key with kdf_alg "Sc" and
// opslimit = memlimit = 0, storing the key bytes in clear. Node's sign-sums.mjs reads that fine,
// but minisign 0.12 keys off kdf_alg alone: "Sc" means "encrypted", so it prompts for a password
// and runs scrypt with opslimit 0, which fails (verified locally 2026-09-13: `minisign -S`
// printed "Password:" and produced no signature). minisign's own unencrypted format (`-W`) is the
// same layout with kdf_alg = "\0\0"; the checksum on the key does not cover kdf_alg, so the
// rewrite is two bytes. The release job runs this on the secret material inside $RUNNER_TEMP.
//
// Refuses: anything that is not a minisign secret key, a key that is actually encrypted
// (opslimit != 0), or a key whose checksum does not verify (a truncated or corrupted secret).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { blake2b } = await import(join(here, "..", "installer", "keys", "blake2b.mjs"));

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: minisign-plain-key.mjs <in.key> <out.key>");
  process.exit(2);
}
const lines = readFileSync(input, "utf8").split("\n");
const comment = lines[0] ?? "";
const raw = Buffer.from(lines[1] ?? "", "base64");
if (raw.length !== 158 || raw.subarray(0, 2).toString() !== "Ed") {
  console.error("minisign-plain-key: not a minisign secret key");
  process.exit(1);
}
const kdf = raw.subarray(2, 4).toString("latin1");
const opslimit = raw.readBigUInt64LE(38);
const memlimit = raw.readBigUInt64LE(46);
if (kdf === "\0\0") {
  // Already in the unencrypted format; pass it through unchanged.
} else if (kdf !== "Sc" || opslimit !== 0n || memlimit !== 0n) {
  console.error("minisign-plain-key: key is password-protected; sign with `minisign -S` interactively or strip the password with `minisign -R -W -s <key>` on a trusted machine");
  process.exit(1);
}
const keyId = raw.subarray(54, 62);
const sk = raw.subarray(62, 126);
const chk = raw.subarray(126, 158);
if (!blake2b(Buffer.concat([Buffer.from("Ed"), keyId, sk]), 32).equals(chk)) {
  console.error("minisign-plain-key: secret key checksum mismatch; the key is corrupted or truncated");
  process.exit(1);
}
const out = Buffer.from(raw);
out[2] = 0;
out[3] = 0;
writeFileSync(output, `${comment}\n${out.toString("base64")}\n`, { mode: 0o600 });
console.log(`minisign-plain-key: wrote ${output} (key ${Buffer.from(keyId).reverse().toString("hex").toUpperCase()})`);
