/**
 * The audit signing key.
 *
 * Ed25519 through `node:crypto`, nothing else. The private key lives at `<profile>/keys/audit.key`
 * as PKCS8 PEM, owner-only, in an owner-only directory, and is generated the first time anything
 * asks for it; the public key sits beside it as `audit.pub` so an operator can hand it to whoever
 * verifies their exports. The private key never leaves this module as anything but a signature.
 *
 * A signature is over the sha256 digest of the export file, so the verifier needs the file, its
 * `.sig` and the public key — never the profile that produced it.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import path from "node:path";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../config/atomic-fs.js";
import { EXIT, TrentError } from "../errors/index.js";

export const AUDIT_KEY_DIR = "keys";
export const AUDIT_PRIVATE_KEY_FILE = "audit.key";
export const AUDIT_PUBLIC_KEY_FILE = "audit.pub";

const PRIVATE_KEY_MODE = 0o600;
const PUBLIC_KEY_MODE = 0o644;
const KEY_DIR_MODE = 0o700;

/** Fingerprints are the sha256 of the DER-encoded SubjectPublicKeyInfo, prefixed so the hash is named. */
const FINGERPRINT_PREFIX = "sha256:";

export interface AuditKeyPaths {
  readonly dir: string;
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface AuditKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly fingerprint: string;
}

export function auditKeyPaths(profileDir: string): AuditKeyPaths {
  const dir = path.join(profileDir, AUDIT_KEY_DIR);
  return {
    dir,
    privateKey: path.join(dir, AUDIT_PRIVATE_KEY_FILE),
    publicKey: path.join(dir, AUDIT_PUBLIC_KEY_FILE),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `${FINGERPRINT_PREFIX}${sha256Hex(der)}`;
}

function publicPemOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "pem" }).toString();
}

export function generateAuditKeyPair(): AuditKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey, fingerprint: publicKeyFingerprint(publicKey) };
}

/** Base64 ed25519 signature over the raw digest bytes. */
export function signDigest(privateKeyPem: string, digestHex: string): string {
  return sign(null, Buffer.from(digestHex, "hex"), createPrivateKey(privateKeyPem)).toString("base64");
}

/** False for a wrong key, a changed digest or a signature that is not one — never a throw. */
export function verifyDigestSignature(publicKeyPem: string, digestHex: string, signatureBase64: string): boolean {
  try {
    return verify(null, Buffer.from(digestHex, "hex"), createPublicKey(publicKeyPem), Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** The profile's public key, or null when no key has been generated yet. */
export function readAuditPublicKey(profileDir: string, io: ConfigIO = NODE_IO): string | null {
  const paths = auditKeyPaths(profileDir);
  return io.existsSync(paths.publicKey) ? io.readFileSync(paths.publicKey, "utf8") : null;
}

export function auditKeyExists(profileDir: string, io: ConfigIO = NODE_IO): boolean {
  return io.existsSync(auditKeyPaths(profileDir).privateKey);
}

/**
 * The profile's key pair, generated on first use. The public key file is re-derived from the
 * private key whenever it is missing, so deleting `audit.pub` never changes the signer.
 */
export function loadOrCreateAuditKey(profileDir: string, io: ConfigIO = NODE_IO): AuditKeyPair {
  const paths = auditKeyPaths(profileDir);
  if (!io.existsSync(paths.dir)) io.mkdirSync(paths.dir, { recursive: true });
  try {
    io.chmodSync(paths.dir, KEY_DIR_MODE);
  } catch {
    // A directory that cannot be chmodded (a network mount) still has to be usable.
  }

  if (io.existsSync(paths.privateKey)) {
    const privateKeyPem = io.readFileSync(paths.privateKey, "utf8");
    let publicKeyPem: string;
    try {
      publicKeyPem = publicPemOf(privateKeyPem);
    } catch (cause) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "audit.key",
        message: "the audit signing key is not a readable PKCS8 ed25519 private key",
        target: paths.privateKey,
        cause,
      });
    }
    if (!io.existsSync(paths.publicKey) || io.readFileSync(paths.publicKey, "utf8") !== publicKeyPem) {
      atomicWriteFileSync(io, paths.publicKey, publicKeyPem, PUBLIC_KEY_MODE);
    }
    return { privateKeyPem, publicKeyPem, fingerprint: publicKeyFingerprint(publicKeyPem) };
  }

  const pair = generateAuditKeyPair();
  atomicWriteFileSync(io, paths.privateKey, pair.privateKeyPem, PRIVATE_KEY_MODE);
  atomicWriteFileSync(io, paths.publicKey, pair.publicKeyPem, PUBLIC_KEY_MODE);
  return pair;
}
