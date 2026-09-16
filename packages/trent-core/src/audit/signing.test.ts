/**
 * The audit signing key: ed25519 through `node:crypto`, generated on first use under
 * `<profile>/keys/`, owner-only. A signature is over the sha256 digest of an export file, so a
 * verifier needs the file, the `.sig` and nothing from the profile that produced it.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditKeyPaths,
  generateAuditKeyPair,
  loadOrCreateAuditKey,
  publicKeyFingerprint,
  readAuditPublicKey,
  sha256Hex,
  signDigest,
  verifyDigestSignature,
} from "./signing.js";

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "trent-audit-signing-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("audit signing round-trip", () => {
  it("verifies a signature made with the matching key over the same digest", () => {
    const key = generateAuditKeyPair();
    const digest = sha256Hex(Buffer.from("three chained rows\n"));
    const signature = signDigest(key.privateKeyPem, digest);
    expect(verifyDigestSignature(key.publicKeyPem, digest, signature)).toBe(true);
  });

  it("rejects the signature once a single byte of the signed content changes", () => {
    const key = generateAuditKeyPair();
    const original = Buffer.from("three chained rows\n");
    const signature = signDigest(key.privateKeyPem, sha256Hex(original));
    const tampered = Buffer.from(original);
    tampered[4] = tampered[4]! ^ 0x01;
    expect(verifyDigestSignature(key.publicKeyPem, sha256Hex(tampered), signature)).toBe(false);
  });

  it("rejects a signature made with a different key", () => {
    const signer = generateAuditKeyPair();
    const other = generateAuditKeyPair();
    const digest = sha256Hex(Buffer.from("three chained rows\n"));
    const signature = signDigest(signer.privateKeyPem, digest);
    expect(verifyDigestSignature(other.publicKeyPem, digest, signature)).toBe(false);
  });

  it("returns false, never throws, for a signature that is not valid base64 of the right length", () => {
    const key = generateAuditKeyPair();
    const digest = sha256Hex(Buffer.from("x"));
    expect(verifyDigestSignature(key.publicKeyPem, digest, "not-a-signature")).toBe(false);
  });
});

describe("the profile key file", () => {
  it("is generated on first use as 0600 PKCS8 PEM in a 0700 directory, with the public key beside it", () => {
    const profile = tmpDir();
    const paths = auditKeyPaths(profile);
    expect(paths.privateKey).toBe(path.join(profile, "keys", "audit.key"));
    expect(paths.publicKey).toBe(path.join(profile, "keys", "audit.pub"));

    const key = loadOrCreateAuditKey(profile);
    expect(fs.readFileSync(paths.privateKey, "utf8")).toContain("BEGIN PRIVATE KEY");
    expect(fs.readFileSync(paths.publicKey, "utf8")).toContain("BEGIN PUBLIC KEY");
    expect(fs.statSync(paths.privateKey).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(key.fingerprint).toBe(publicKeyFingerprint(key.publicKeyPem));
    expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("loads the same key on the second call instead of minting a new one", () => {
    const profile = tmpDir();
    const first = loadOrCreateAuditKey(profile);
    const second = loadOrCreateAuditKey(profile);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });

  it("re-derives a missing public key file from the private key", () => {
    const profile = tmpDir();
    const first = loadOrCreateAuditKey(profile);
    fs.rmSync(auditKeyPaths(profile).publicKey);
    expect(readAuditPublicKey(profile)).toBeNull();
    const second = loadOrCreateAuditKey(profile);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(readAuditPublicKey(profile)).toBe(first.publicKeyPem);
  });
});
