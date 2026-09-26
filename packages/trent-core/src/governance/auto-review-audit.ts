/**
 * [H1] The approvals audit chain: every auto-review decision, and every human override of one, as a
 * hash-chained NDJSON file in the profile, `<profile>/approvals-audit.ndjson`.
 *
 * Each line is one row in the exact shape of the app's `AuditLog` table (`audit/export.ts`
 * `AuditRow`), hashed with the same formula (`computeAuditRowHash`, which mirrors
 * `apps/web/lib/audit-log.ts` `computeAuditHash`) and linked to the row before it, so the verifier the
 * signed export uses (`audit/verify.ts` `walkAuditChain`) re-walks this file unchanged and names the
 * first line that was edited. The wrapper has no writer for the app's own table (it would open a
 * database connection from the CLI, `skills/foundry.ts`), which is why the chain lives here.
 *
 * Appends re-read the tail first; two processes appending in the same instant could fork the chain,
 * and `walkAuditChain` would then name the line where it forks rather than hide it. Mode 0600: a
 * reason can quote the content of a message that was held.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeAuditRowHash, GENESIS_HASH, serializeAuditRow, type AuditRow } from "../audit/export.js";
import { walkAuditChain, type AuditVerifyFailure } from "../audit/verify.js";

export const APPROVAL_AUDIT_FILE = "approvals-audit.ndjson";
const FILE_MODE = 0o600;
/** The chain's company: the approval bridge's own default scope in standalone mode. */
export const APPROVAL_AUDIT_COMPANY = "standalone";
const SUMMARY_LIMIT = 400;

export type ApprovalAuditAction = "approval.approved" | "approval.denied" | "approval.escalated" | "approval.reversed";

export interface ApprovalAuditEntry {
  readonly actor: string;
  readonly action: ApprovalAuditAction;
  /** The approval row's id. */
  readonly approvalId: string;
  readonly summary: string;
  readonly at?: Date;
}

export function approvalAuditPath(profileDir: string): string {
  return path.join(profileDir, APPROVAL_AUDIT_FILE);
}

function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT - 3)}...`;
}

/**
 * Appends one row linked to the last row that parses and returns it. A damaged line is not repaired
 * or dropped: the verifier names it as "not an audit row", and the chain carries on from the row
 * before it, which is exactly how `walkAuditChain` reads past such a line.
 */
export function appendApprovalAudit(profileDir: string, entry: ApprovalAuditEntry): AuditRow {
  const file = approvalAuditPath(profileDir);
  const prevHash = readApprovalAudit(profileDir).at(-1)?.hash ?? GENESIS_HASH;
  const at = entry.at ?? new Date();
  const partial: Omit<AuditRow, "hash"> = {
    id: `aud_${String(at.getTime())}_${crypto.randomBytes(3).toString("hex")}`,
    companyId: APPROVAL_AUDIT_COMPANY,
    actor: entry.actor,
    action: entry.action,
    objectType: "approval",
    objectId: entry.approvalId,
    summary: oneLine(entry.summary),
    prevHash,
    createdAt: at.toISOString(),
  };
  const row: AuditRow = { ...partial, hash: computeAuditRowHash(partial) };
  fs.mkdirSync(profileDir, { recursive: true });
  fs.appendFileSync(file, `${serializeAuditRow(row)}\n`, { mode: FILE_MODE });
  return row;
}

function parseRow(line: string): AuditRow | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<AuditRow> | null;
    return parsed !== null && typeof parsed === "object" && typeof parsed.hash === "string" && typeof parsed.objectId === "string" ? (parsed as AuditRow) : undefined;
  } catch {
    // Not a row. `verifyApprovalAudit` reports it with its line number; a reader lists the rest.
    return undefined;
  }
}

/** Every row, oldest first. A line that is not a row is left out here; `verifyApprovalAudit` names it. */
export function readApprovalAudit(profileDir: string): AuditRow[] {
  return lines(approvalAuditPath(profileDir))
    .map(parseRow)
    .filter((row): row is AuditRow => row !== undefined);
}

/** Re-walks the chain with the signed export's own verifier. No file is an empty, intact chain. */
export function verifyApprovalAudit(profileDir: string): { rows: number; failures: AuditVerifyFailure[] } {
  const file = approvalAuditPath(profileDir);
  return walkAuditChain(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
}
