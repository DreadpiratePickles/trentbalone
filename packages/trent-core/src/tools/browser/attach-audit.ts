/**
 * [H5] What an attached session did, and on which site: `<profile>/browser/attach-audit.ndjson`.
 *
 * One row per attach, per action the owner approved, and per detach, in the exact shape and hash
 * of the app's `AuditLog` table (`audit/export.ts` `AuditRow`, `computeAuditRowHash`), each linked
 * to the row before it, so `audit/verify.ts` `walkAuditChain` re-walks the file unchanged and names
 * the first line that was edited — the same chain `governance/auto-review-audit.ts` keeps for
 * approvals. A site is recorded as origin + path: never the query or the fragment (a page URL can
 * carry an OAuth code), and never the text that was typed. Mode 0600.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { computeAuditRowHash, GENESIS_HASH, serializeAuditRow, type AuditRow } from "../../audit/export.js";
import { walkAuditChain, type AuditVerifyFailure } from "../../audit/verify.js";

export const ATTACH_AUDIT_FILE = "attach-audit.ndjson";
/** The chain's company, as in the approvals chain: the standalone scope. */
export const ATTACH_AUDIT_COMPANY = "standalone";
const FILE_MODE = 0o600;
const SUMMARY_LIMIT = 400;

export interface AttachAuditEntry {
  /** The seat that acted, or `trent` outside one. */
  readonly actor: string;
  /** `browser.attach`, `browser.<tool without its prefix>`, or `browser.detach`. */
  readonly action: string;
  readonly objectType: "browser_site" | "browser_session";
  /** The site's origin for an action; the attach session's id for attach and detach. */
  readonly objectId: string;
  readonly summary: string;
  readonly at?: Date;
}

export function attachAuditPath(profileDir: string): string {
  return path.join(profileDir, "browser", ATTACH_AUDIT_FILE);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT - 3)}...`;
}

function parseRow(line: string): AuditRow | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<AuditRow> | null;
    return parsed !== null && typeof parsed === "object" && typeof parsed.hash === "string" && typeof parsed.objectId === "string" ? (parsed as AuditRow) : undefined;
  } catch {
    // Not a row; `verifyAttachAudit` names it with its line number.
    return undefined;
  }
}

/** Every row, oldest first. A line that is not a row is left out here; the verifier names it. */
export function readAttachAudit(profileDir: string): AuditRow[] {
  const file = attachAuditPath(profileDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseRow)
    .filter((row): row is AuditRow => row !== undefined);
}

/** Appends one row linked to the last readable row and returns it. */
export function appendAttachAudit(profileDir: string, entry: AttachAuditEntry): AuditRow {
  const file = attachAuditPath(profileDir);
  const prevHash = readAttachAudit(profileDir).at(-1)?.hash ?? GENESIS_HASH;
  const at = entry.at ?? new Date();
  const partial: Omit<AuditRow, "hash"> = {
    id: `aud_${String(at.getTime())}_${crypto.randomBytes(3).toString("hex")}`,
    companyId: ATTACH_AUDIT_COMPANY,
    actor: entry.actor,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    summary: oneLine(entry.summary),
    prevHash,
    createdAt: at.toISOString(),
  };
  const row: AuditRow = { ...partial, hash: computeAuditRowHash(partial) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${serializeAuditRow(row)}\n`, { mode: FILE_MODE });
  return row;
}

/** Re-walks the chain with the signed export's own verifier. No file is an empty, intact chain. */
export function verifyAttachAudit(profileDir: string): { rows: number; failures: AuditVerifyFailure[] } {
  const file = attachAuditPath(profileDir);
  return walkAuditChain(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
}
