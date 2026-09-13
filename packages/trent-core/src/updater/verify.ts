/**
 * Two checks, in this order, both mandatory:
 *   1. The minisign signature on `SHA256SUMS` verifies under the embedded release public key.
 *   2. The artefact's SHA-256 equals the entry for its file name in the now-trusted sums file.
 *
 * A release host that has been compromised can rewrite SHA256SUMS to match a malicious binary, and
 * step 2 alone would accept it. Step 1 is what makes that impossible without the private key.
 * The digest is computed over the exact file the caller will install, by path, right here.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import { verifyMinisign } from "./minisign.js";
import { TRENT_RELEASE_PUBLIC_KEY } from "./publicKey.js";

export interface VerifyOptions {
  /** Minisign public key file text. Defaults to the embedded release key. */
  publicKey?: string;
}

export interface VerifiedArtifact {
  path: string;
  sha256: string;
  keyId: string;
  trustedComment: string;
}

function refuse(message: string, target?: string, context?: Record<string, unknown>): TrentError {
  return new TrentError({
    code: EXIT.CONFIG,
    operation: "updater.verify",
    message,
    ...(target === undefined ? {} : { target }),
    ...(context === undefined ? {} : { context }),
  });
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** Parse `sha256sum` output: `<64 hex>  <name>` or `<64 hex> *<name>`, one per line. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (match === null) throw refuse("SHA256SUMS has a malformed line", line.slice(0, 80));
    sums.set(match[2] ?? "", (match[1] ?? "").toLowerCase());
  }
  return sums;
}

export function verifyArtifact(artifactPath: string, sumsPath: string, sigPath: string, options: VerifyOptions = {}): Promise<VerifiedArtifact> {
  return Promise.resolve().then(() => {
    const sums = fs.readFileSync(sumsPath);
    const signature = fs.readFileSync(sigPath, "utf8");
    const signed = verifyMinisign(sums, signature, options.publicKey ?? TRENT_RELEASE_PUBLIC_KEY);

    const name = path.basename(artifactPath);
    const expected = parseSums(sums.toString("utf8")).get(name);
    if (expected === undefined) throw refuse("signed SHA256SUMS has no entry for this artefact", name);
    const actual = sha256File(artifactPath);
    if (actual !== expected) {
      throw refuse("SHA-256 mismatch: the artefact does not match the signed checksum", name, { expected, actual });
    }
    return { path: artifactPath, sha256: actual, keyId: signed.keyId, trustedComment: signed.trustedComment };
  });
}
