/**
 * Signed audit export.
 *
 * The store's `AuditLog` rows go out as NDJSON, one row per line, in chain order — every company's
 * chain from its `genesis` entry forward — followed by a detached `.sig`: one JSON line carrying
 * the ed25519 signature over the file's sha256, the signer's fingerprint and public key. The hash
 * chain itself is the wrapped application's (`apps/web/lib/audit-log.ts` `computeAuditHash`);
 * `computeAuditRowHash` re-states that formula so `verify` can re-walk it without a database.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../config/atomic-fs.js";
import { EXIT, TrentError } from "../errors/index.js";
import { sha256Hex, signDigest, type AuditKeyPair } from "./signing.js";

/** One row of the `AuditLog` table, `createdAt` as ISO 8601 (the hash is computed over that string). */
export interface AuditRow {
  readonly id: string;
  readonly companyId: string;
  readonly actor: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly summary: string;
  readonly hash: string;
  readonly prevHash: string;
  readonly createdAt: string;
}

/** Where the rows come from. A store that grows `listAuditRows` satisfies it directly. */
export interface AuditRowSource {
  listAuditRows(): Promise<AuditRow[]>;
}

export const AUDIT_SIGNATURE_FORMAT = "trent-audit-signature/1";
export const GENESIS_HASH = "genesis";

export interface AuditSignature {
  readonly format: typeof AUDIT_SIGNATURE_FORMAT;
  readonly algorithm: "ed25519";
  /** `sha256:<hex>` of the export file's bytes. */
  readonly digest: string;
  /** Base64 ed25519 signature over the raw digest bytes. */
  readonly signature: string;
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly rows: number;
  readonly signedAt: string;
}

export interface ExportAuditOptions {
  readonly source: AuditRowSource;
  readonly outFile: string;
  readonly key: AuditKeyPair;
  readonly now?: () => Date;
  readonly io?: ConfigIO;
}

export interface ExportAuditResult {
  readonly file: string;
  readonly signatureFile: string;
  readonly rows: number;
  readonly digest: string;
  readonly fingerprint: string;
}

const NDJSON_FILE_MODE = 0o600;

/** Mirrors `computeAuditHash` in `apps/web/lib/audit-log.ts`, field for field, in that order. */
export function computeAuditRowHash(row: Omit<AuditRow, "hash">): string {
  return createHash("sha256")
    .update(row.prevHash + row.id + row.actor + row.action + row.objectId + row.summary + row.createdAt)
    .digest("hex");
}

export function signaturePathFor(file: string): string {
  return `${file}.sig`;
}

export function defaultExportPath(cwd: string, now: Date): string {
  return path.join(cwd, `trent-audit-${now.toISOString().slice(0, 10)}.ndjson`);
}

function byTime(a: AuditRow, b: AuditRow): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Chain order: each company's rows oldest first, companies in order of their first entry. Within a
 * company the wrapped application appends under a serializable transaction, so time order is chain
 * order; `verify` checks that claim link by link.
 */
export function orderAuditRows(rows: readonly AuditRow[]): AuditRow[] {
  const sorted = [...rows].sort(byTime);
  const chains = new Map<string, AuditRow[]>();
  for (const row of sorted) {
    const chain = chains.get(row.companyId);
    if (chain === undefined) chains.set(row.companyId, [row]);
    else chain.push(row);
  }
  return [...chains.values()].flat();
}

/** Stable key order, so the same rows always produce byte-identical lines. */
export function serializeAuditRow(row: AuditRow): string {
  return JSON.stringify({
    id: row.id,
    companyId: row.companyId,
    actor: row.actor,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    summary: row.summary,
    hash: row.hash,
    prevHash: row.prevHash,
    createdAt: row.createdAt,
  });
}

export async function exportAudit(options: ExportAuditOptions): Promise<ExportAuditResult> {
  const io = options.io ?? NODE_IO;
  const now = options.now ?? (() => new Date());
  const rows = orderAuditRows(await options.source.listAuditRows());
  const body = rows.map(serializeAuditRow).join("\n") + (rows.length > 0 ? "\n" : "");
  const digestHex = sha256Hex(Buffer.from(body, "utf8"));

  const signature: AuditSignature = {
    format: AUDIT_SIGNATURE_FORMAT,
    algorithm: "ed25519",
    digest: `sha256:${digestHex}`,
    signature: signDigest(options.key.privateKeyPem, digestHex),
    fingerprint: options.key.fingerprint,
    publicKey: options.key.publicKeyPem,
    rows: rows.length,
    signedAt: now().toISOString(),
  };

  const dir = path.dirname(options.outFile);
  if (!io.existsSync(dir)) io.mkdirSync(dir, { recursive: true });
  const signatureFile = signaturePathFor(options.outFile);
  atomicWriteFileSync(io, options.outFile, body, NDJSON_FILE_MODE);
  atomicWriteFileSync(io, signatureFile, `${JSON.stringify(signature)}\n`, NDJSON_FILE_MODE);

  return { file: options.outFile, signatureFile, rows: rows.length, digest: signature.digest, fingerprint: signature.fingerprint };
}

/** A Prisma row as the generated client returns it: `createdAt` is a `Date`. */
type PrismaAuditRow = Omit<AuditRow, "createdAt"> & { createdAt: Date | string };

interface PrismaAuditClient {
  auditLog: { findMany(args: { orderBy: Array<Record<string, "asc" | "desc">> }): Promise<PrismaAuditRow[]> };
}

function hasListAuditRows(store: unknown): store is AuditRowSource {
  return typeof (store as { listAuditRows?: unknown }).listAuditRows === "function";
}

function prismaClientOf(store: unknown): PrismaAuditClient | null {
  const client = (store as { prisma?: { auditLog?: { findMany?: unknown } } }).prisma;
  return typeof client?.auditLog?.findMany === "function" ? (client as PrismaAuditClient) : null;
}

/**
 * The audit rows behind a store. `StorePort` does not yet carry an audit reader, so a
 * Prisma-backed store is read through its client's `auditLog` table; anything that exposes
 * `listAuditRows` is used as is, and anything else is refused by name rather than exported empty.
 */
export function auditSourceFor(store: unknown): AuditRowSource {
  if (hasListAuditRows(store)) return store;
  const client = prismaClientOf(store);
  if (client !== null) {
    return {
      async listAuditRows(): Promise<AuditRow[]> {
        const rows = await client.auditLog.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        return rows.map((r) => ({
          id: r.id,
          companyId: r.companyId,
          actor: r.actor,
          action: r.action,
          objectType: r.objectType,
          objectId: r.objectId,
          summary: r.summary,
          hash: r.hash,
          prevHash: r.prevHash,
          createdAt: typeof r.createdAt === "string" ? r.createdAt : r.createdAt.toISOString(),
        }));
      },
    };
  }
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "audit.export",
    message: "this store has no audit table to read; only the durable SQLite store carries the audit chain",
  });
}
