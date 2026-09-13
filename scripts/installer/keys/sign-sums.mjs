#!/usr/bin/env node
// sign-sums.mjs — sign a SHA256SUMS file the way the release job must.
//
//   node scripts/installer/keys/sign-sums.mjs <SHA256SUMS> [--minisign-key K] [--ecdsa-key K]
//
// Produces, next to the input:
//   SHA256SUMS.minisig   minisign signature (Ed25519, prehashed "ED" mode)  == `minisign -S -s <key> -m SHA256SUMS`
//   SHA256SUMS.sig       ECDSA P-256 / SHA-256, DER                          == `openssl dgst -sha256 -sign ecdsa-p256.key.pem -out SHA256SUMS.sig SHA256SUMS`
//
// The release job should run the real tools (commands above); this script exists so the tests
// can sign locally and so the formats are pinned in code. Keys default to the files in this
// directory; pass paths for CI secrets written to disk.
import { createPrivateKey, sign as cryptoSign, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "./blake2b.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("usage: sign-sums.mjs <SHA256SUMS> [--minisign-key K] [--ecdsa-key K]"); process.exit(2); }
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const msKeyPath = opt("--minisign-key", join(here, "minisign.key"));
const ecKeyPath = opt("--ecdsa-key", join(here, "ecdsa-p256.key.pem"));

const message = readFileSync(file);

// ---- minisign
const secLines = readFileSync(msKeyPath, "utf8").split("\n");
const sec = Buffer.from(secLines[1], "base64");
if (sec.subarray(0, 2).toString() !== "Ed" || sec.length !== 158) throw new Error("not a minisign secret key");
if (sec.readBigUInt64LE(38) !== 0n) throw new Error("encrypted minisign keys are not supported here; use the minisign tool");
const keyId = sec.subarray(54, 62);
const seed = sec.subarray(62, 94);
const pk = sec.subarray(94, 126);
const chk = sec.subarray(126, 158);
if (!blake2b(Buffer.concat([Buffer.from("Ed"), keyId, seed, pk]), 32).equals(chk)) throw new Error("minisign secret key checksum mismatch");
// PKCS#8 wrapper for a raw Ed25519 seed
const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
const edKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
const prehash = blake2b(message, 64);
const sig = cryptoSign(null, prehash, edKey);
const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${basename(file)}\thashed`;
const globalSig = cryptoSign(null, Buffer.concat([sig, Buffer.from(trusted)]), edKey);
const minisig =
  `untrusted comment: signature from minisign secret key\n` +
  Buffer.concat([Buffer.from("ED"), keyId, sig]).toString("base64") + "\n" +
  `trusted comment: ${trusted}\n` +
  globalSig.toString("base64") + "\n";
writeFileSync(file + ".minisig", minisig);

// ---- ECDSA P-256 co-signature (DER, what `openssl dgst -sha256 -sign` emits)
const ecKey = createPrivateKey(readFileSync(ecKeyPath));
const der = cryptoSign("sha256", message, { key: ecKey, dsaEncoding: "der" });
writeFileSync(file + ".sig", der);
console.log(`signed ${file}: ${file}.minisig (key ${Buffer.from(keyId).reverse().toString("hex").toUpperCase()}), ${file}.sig`);
