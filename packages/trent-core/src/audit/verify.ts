/**
 * Verify a signed audit export.
 *
 * Two independent checks, both always run so the report can say which one a tampered file
 * failed: the hash chain is re-walked row by row (a broken row is named by its 1-based line
 * number), then the detached signature is checked over the file's sha256. With a trusted public
 * key the `.sig` must have been made by that key; without one the key embedded in the `.sig` is
 * used and the caller decides what the reported signer fingerprint is worth.
 */

import { NODE_IO, type ConfigIO } from "../config/atomic-fs.js";
import { EXIT, TrentError } from "../errors/index.js";
import {
  AUDIT_SIGNATURE_FORMAT,
  computeAuditRowHash,
  GENESIS_HASH,
  signaturePathFor,
  type AuditRow,
  type AuditSignature,
} from "./export.js";
import { publicKeyFingerprint, sha256Hex, verifyDigestSignature } from "./signing.js";

export type AuditVerifyFailureKind = "chain" | "signature" | "format";

export interface AuditVerifyFailure {
  readonly kind: AuditVerifyFailureKind;
  /** 1-based NDJSON line number; absent for a failure that is not about one row. */
  readonly row?: number;
  readonly message: string;
}

export interface AuditVerifyReport {
  readonly ok: boolean;
  readonly file: string;
  readonly signatureFile: string;
  readonly rows: number;
  /** Fingerprint of the key the `.sig` names; empty when there is no readable `.sig`. */
  readonly signer: string;
  readonly digest: string;
  readonly failures: readonly AuditVerifyFailure[];
}

export interface VerifyAuditOptions {
  /** When given, a `.sig` made by any other key fails, whatever key it embeds. */
  readonly trustedPublicKeyPem?: string;
  readonly io?: ConfigIO;
}

const ROW_FIELDS: ReadonlyArray<keyof AuditRow> = [
  "id", "companyId", "actor", "action", "objectType", "objectId", "summary", "hash", "prevHash", "createdAt",
];

function parseRow(line: string): AuditRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  return ROW_FIELDS.every((f) => typeof candidate[f] === "string") ? (candidate as unknown as AuditRow) : null;
}

/** Re-walks every company's chain over the file's lines; failures name the line. */
export function walkAuditChain(body: string): { rows: number; failures: AuditVerifyFailure[] } {
  const failures: AuditVerifyFailure[] = [];
  const expectedPrev = new Map<string, string>();
  const lines = body.split("\n").filter((l) => l.length > 0);
  lines.forEach((line, index) => {
    const row = index + 1;
    const parsed = parseRow(line);
    if (parsed === null) {
      failures.push({ kind: "format", row, message: `line ${row} is not an audit row` });
      return;
    }
    const prev = expectedPrev.get(parsed.companyId) ?? GENESIS_HASH;
    if (parsed.prevHash !== prev) {
      failures.push({ kind: "chain", row, message: `row ${row} (${parsed.id}) does not link to the previous entry of company ${parsed.companyId}` });
    }
    if (computeAuditRowHash(parsed) !== parsed.hash) {
      failures.push({ kind: "chain", row, message: `row ${row} (${parsed.id}) does not match its recorded hash` });
    }
    expectedPrev.set(parsed.companyId, parsed.hash);
  });
  return { rows: lines.length, failures };
}

function readSignature(signatureFile: string, io: ConfigIO): AuditSignature | AuditVerifyFailure {
  if (!io.existsSync(signatureFile)) {
    return { kind: "signature", message: `no signature file beside the export (${signatureFile})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readFileSync(signatureFile, "utf8").split("\n")[0] ?? "");
  } catch {
    return { kind: "signature", message: `the signature file is not a JSON line (${signatureFile})` };
  }
  const sig = parsed as Partial<AuditSignature>;
  if (sig.format !== AUDIT_SIGNATURE_FORMAT || sig.algorithm !== "ed25519") {
    return { kind: "signature", message: `the signature file is not a ${AUDIT_SIGNATURE_FORMAT} ed25519 signature` };
  }
  if (typeof sig.signature !== "string" || typeof sig.publicKey !== "string" || typeof sig.digest !== "string") {
    return { kind: "signature", message: "the signature file is missing its signature, public key or digest" };
  }
  return sig as AuditSignature;
}

function checkSignature(
  sig: AuditSignature,
  digestHex: string,
  trustedPublicKeyPem: string | undefined,
): AuditVerifyFailure | null {
  let signer: string;
  try {
    signer = publicKeyFingerprint(sig.publicKey);
  } catch {
    return { kind: "signature", message: "the public key in the signature file is not a readable key" };
  }
  if (signer !== sig.fingerprint) {
    return { kind: "signature", message: `the signature file names ${sig.fingerprint} but embeds the key ${signer}` };
  }
  let publicKeyPem = sig.publicKey;
  if (trustedPublicKeyPem !== undefined) {
    const trusted = publicKeyFingerprint(trustedPublicKeyPem);
    if (trusted !== signer) {
      return { kind: "signature", message: `the export was signed by ${signer}, not by the trusted key ${trusted}` };
    }
    publicKeyPem = trustedPublicKeyPem;
  }
  if (sig.digest !== `sha256:${digestHex}`) {
    return { kind: "signature", message: `the file's sha256 is not the digest the signature covers (${sig.digest})` };
  }
  if (!verifyDigestSignature(publicKeyPem, digestHex, sig.signature)) {
    return { kind: "signature", message: `the ed25519 signature by ${signer} does not verify over the file` };
  }
  return null;
}

export async function verifyAuditExport(file: string, options: VerifyAuditOptions = {}): Promise<AuditVerifyReport> {
  const io = options.io ?? NODE_IO;
  if (!io.existsSync(file)) {
    throw new TrentError({ code: EXIT.USAGE, operation: "audit.verify", message: "no such export file", target: file });
  }
  const body = io.readFileSync(file, "utf8");
  const digestHex = sha256Hex(Buffer.from(body, "utf8"));
  const signatureFile = signaturePathFor(file);

  const chain = walkAuditChain(body);
  const failures: AuditVerifyFailure[] = [...chain.failures];

  const sig = readSignature(signatureFile, io);
  let signer = "";
  if ("kind" in sig) {
    failures.push(sig);
  } else {
    signer = typeof sig.fingerprint === "string" ? sig.fingerprint : "";
    const failure = checkSignature(sig, digestHex, options.trustedPublicKeyPem);
    if (failure !== null) failures.push(failure);
  }

  return {
    ok: failures.length === 0,
    file,
    signatureFile,
    rows: chain.rows,
    signer,
    digest: `sha256:${digestHex}`,
    failures,
  };
}
