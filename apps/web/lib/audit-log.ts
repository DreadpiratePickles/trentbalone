import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import type { AuditLog } from "@/lib/types";

/**
 * Pure function: compute SHA-256 hash for an audit log entry.
 * Deterministic — same inputs always produce the same hash.
 */
export function computeAuditHash(
  prevHash: string,
  id: string,
  actor: string,
  action: string,
  objectId: string,
  summary: string,
  createdAt: string
): string {
  return createHash("sha256")
    .update(prevHash + id + actor + action + objectId + summary + createdAt)
    .digest("hex");
}

const IS_POSTGRES = !!(process.env.DATABASE_URL?.startsWith("postgres"));

/**
 * Append a new entry to the audit log chain for a company.
 * Runs inside a serializable transaction so concurrent appends cannot read
 * the same prevHash and produce a broken chain.
 */
export async function appendAuditLog(
  companyId: string,
  actor: "system" | "user" | "agent",
  action: string,
  objectType: string,
  objectId: string,
  summary: string
): Promise<void> {
  const id = makeId("audit");
  const createdAt = nowIso();

  const txOptions = IS_POSTGRES ? { isolationLevel: "Serializable" as const } : {};

  await db.$transaction(async (tx) => {
    const lastRow = await tx.auditLog.findFirst({
      where: { companyId },
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });
    const prevHash = lastRow?.hash ?? "genesis";
    const hash = computeAuditHash(prevHash, id, actor, action, objectId, summary, createdAt);
    await tx.auditLog.create({
      data: { id, companyId, actor, action, objectType, objectId, summary, hash, prevHash, createdAt: new Date(createdAt) },
    });
  }, txOptions);
}

/**
 * Walk the audit chain for a company (oldest first) and verify every hash.
 * Returns { valid, count } on success or { valid: false, brokenAt, count } on failure.
 */
export async function verifyAuditChain(
  companyId: string
): Promise<{ valid: boolean; count: number; brokenAt?: string }> {
  const rows = await db.auditLog.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: { id: true, actor: true, action: true, objectId: true, summary: true, hash: true, prevHash: true, createdAt: true },
  });
  const entries = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  let count = 0;
  for (const entry of entries) {
    const expected = computeAuditHash(
      entry.prevHash,
      entry.id,
      entry.actor,
      entry.action,
      entry.objectId,
      entry.summary,
      entry.createdAt
    );
    if (expected !== entry.hash) return { valid: false, count, brokenAt: entry.id };
    count++;
  }
  return { valid: true, count };
}
