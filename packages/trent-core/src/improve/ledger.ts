/**
 * The hash ledger (adopted from Hermes' curator): one before/after row on every promote, fix,
 * stage, reject, retire, archive, recover and rollback, carrying the full prior bytes so a
 * rollback needs no other source. Shared helpers for ids, hashes and timestamps live here too.
 */

import { createHash, randomBytes } from "node:crypto";

import type { ImproveLedgerAction, ImproveStorePort, SkillDraftRow, SkillLedgerRow } from "../store/StorePort.js";

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** `prefix_<16 hex>` — same shape as the app's `makeId`, minted locally so no app import is needed. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A stable hash over an unordered set of ids: the sweep's idempotency key. */
export function setHash(ids: readonly string[], salt = ""): string {
  return createHash("sha256").update([...ids].sort().join("\n") + "\n" + salt).digest("hex").slice(0, 32);
}

export interface LedgerEntry {
  readonly action: ImproveLedgerAction;
  readonly artifact: Pick<SkillDraftRow, "id" | "companyId" | "agentId" | "taskType" | "kind">;
  readonly before: string | null;
  readonly after: string | null;
  readonly iterationId: string | null;
  readonly actor: string;
  readonly now?: string;
}

export async function recordLedger(store: ImproveStorePort, entry: LedgerEntry): Promise<SkillLedgerRow> {
  const row: SkillLedgerRow = {
    id: newId("ledger"),
    companyId: entry.artifact.companyId,
    agentId: entry.artifact.agentId,
    taskType: entry.artifact.taskType,
    action: entry.action,
    artifactKind: entry.artifact.kind,
    artifactId: entry.artifact.id,
    beforeHash: entry.before === null ? null : contentHash(entry.before),
    afterHash: entry.after === null ? null : contentHash(entry.after),
    before: entry.before,
    after: entry.after,
    iterationId: entry.iterationId,
    actor: entry.actor,
    createdAt: entry.now ?? nowIso(),
  };
  await store.appendLedger(row);
  return row;
}
