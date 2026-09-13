/**
 * Minisign verification on Node's built-in `crypto`, with no shell-out and no third-party parser.
 *
 * Format, from https://jedisct1.github.io/minisign/ (the reference is the spec section of that page):
 *   public key file : line 1 untrusted comment, line 2 base64("Ed" || key_id[8] || pk[32])
 *   signature file  : line 1 untrusted comment
 *                     line 2 base64(sig_alg[2] || key_id[8] || signature[64])
 *                     line 3 "trusted comment: ..."
 *                     line 4 base64(global_signature[64])
 *   sig_alg "Ed" = Ed25519 over the raw file (legacy); "ED" = Ed25519 over BLAKE2b-512(file), the
 *   default since minisign 0.9 and what `minisign -S` emits today.
 *   global_signature = Ed25519 over (signature[64] || trusted_comment_bytes).
 *
 * Both signatures must verify and the key ids must match; a mismatch of any one is a refusal.
 */

import crypto from "node:crypto";
import { EXIT, TrentError } from "../errors/index.js";

export interface MinisignPublicKey {
  /** Hex, upper case, 16 chars, in the byte order minisign prints (little-endian u64). */
  keyId: string;
  publicKey: Buffer;
  keyObject: crypto.KeyObject;
}

export interface MinisignSignature {
  algorithm: "Ed" | "ED";
  keyId: string;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

function refuse(message: string, target?: string): TrentError {
  return new TrentError({
    code: EXIT.CONFIG,
    operation: "updater.minisign",
    message,
    ...(target === undefined ? {} : { target }),
  });
}

/** minisign prints the key id as a little-endian u64, so the bytes are reversed for display. */
function keyIdHex(bytes: Buffer): string {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}

export function parseMinisignPublicKey(text: string): MinisignPublicKey {
  const body = lines(text).find((l) => l.length > 0 && !l.startsWith("untrusted comment:"));
  if (body === undefined) throw refuse("public key file has no key line");
  const raw = Buffer.from(body, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw refuse("public key is not a minisign Ed25519 key (expected 42 bytes starting with 'Ed')");
  }
  const publicKey = Buffer.from(raw.subarray(10, 42));
  const keyObject = crypto.createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKey.toString("base64url") },
    format: "jwk",
  });
  return { keyId: keyIdHex(raw.subarray(2, 10)), publicKey, keyObject };
}

export function parseMinisignSignature(text: string): MinisignSignature {
  const all = lines(text).filter((l) => l.length > 0);
  if (all.length < 4) throw refuse("signature file is too short (expected 4 lines)");
  const [untrusted, sigLine, trustedLine, globalLine] = all as [string, string, string, string];
  if (!untrusted.startsWith("untrusted comment:")) throw refuse("signature file line 1 is not an untrusted comment");
  if (!trustedLine.startsWith("trusted comment:")) throw refuse("signature file line 3 is not a trusted comment");
  const raw = Buffer.from(sigLine, "base64");
  if (raw.length !== 74) throw refuse(`signature block is ${raw.length} bytes, expected 74`);
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") throw refuse("signature algorithm is neither Ed nor ED");
  const globalSignature = Buffer.from(globalLine, "base64");
  if (globalSignature.length !== 64) throw refuse("global signature is not 64 bytes");
  return {
    algorithm,
    keyId: keyIdHex(raw.subarray(2, 10)),
    signature: Buffer.from(raw.subarray(10, 74)),
    trustedComment: trustedLine.slice("trusted comment:".length).trimStart(),
    globalSignature,
  };
}

/**
 * Verify `content` against a minisign signature file with the given public key. Throws a
 * `TrentError` on any failure; returns the trusted comment on success.
 */
export function verifyMinisign(content: Buffer, signatureText: string, publicKeyText: string): { keyId: string; trustedComment: string } {
  const key = parseMinisignPublicKey(publicKeyText);
  const sig = parseMinisignSignature(signatureText);
  if (sig.keyId !== key.keyId) {
    throw refuse("signature was made with a different key than the embedded release key", sig.keyId);
  }
  const message = sig.algorithm === "ED" ? crypto.createHash("blake2b512").update(content).digest() : content;
  if (!crypto.verify(null, message, key.keyObject, sig.signature)) {
    throw refuse("minisign signature does not verify: the release is not signed by the Trent release key");
  }
  const globalMessage = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]);
  if (!crypto.verify(null, globalMessage, key.keyObject, sig.globalSignature)) {
    throw refuse("minisign global signature does not verify: the trusted comment was altered");
  }
  return { keyId: key.keyId, trustedComment: sig.trustedComment };
}
