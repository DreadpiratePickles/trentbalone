/**
 * [D3] The append-only skill mutation ledger, and the content-addressed blob store beside it.
 *
 * `<profile>/skills/.ledger.ndjson` is one JSON row per line, 0600, appended and never rewritten.
 * Each row carries the hash of its predecessor and its own hash over that link plus its fields —
 * the same construction `audit/export.ts` uses, for the same reason: a row edited in place breaks
 * every hash after it, and `verifyMutationChain` names the line where the break starts.
 *
 * The bytes themselves live in `<profile>/skills/.blobs/<sha256>` (0600 inside 0700), so a row is
 * small, identical content is stored once however many rows reference it, and a rollback restores
 * the exact document rather than a reconstruction of it.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { SKILL_DIR_MODE, SKILL_FILE_MODE } from "../skills/skill-store.js";
import type { CuratorMutation, CuratorMutationKind } from "./types.js";

export const LEDGER_FILE = ".ledger.ndjson";
export const BLOBS_DIR = ".blobs";
export const GENESIS_HASH = "genesis";

export function ledgerPath(skillsDir: string): string {
  return path.join(skillsDir, LEDGER_FILE);
}

export function blobsDir(skillsDir: string): string {
  return path.join(skillsDir, BLOBS_DIR);
}

export function blobPath(skillsDir: string, ref: string): string {
  return path.join(blobsDir(skillsDir), ref);
}

export function contentRef(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Store the bytes under their own hash. Writing the same content twice writes one file. */
export function putSkillBlob(skillsDir: string, content: string): string {
  const ref = contentRef(content);
  const file = blobPath(skillsDir, ref);
  if (fs.existsSync(file)) return ref;
  fs.mkdirSync(blobsDir(skillsDir), { recursive: true, mode: SKILL_DIR_MODE });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: SKILL_FILE_MODE });
  fs.chmodSync(file, SKILL_FILE_MODE);
  return ref;
}

export function readSkillBlob(skillsDir: string, ref: string): string {
  return fs.readFileSync(blobPath(skillsDir, ref), "utf8");
}

/**
 * The link. Deliberately every field the row asserts, in a fixed order: a row whose actor, kind,
 * detail or blob refs were edited no longer hashes to what it claims.
 */
export function computeMutationHash(row: Omit<CuratorMutation, "hash">): string {
  return createHash("sha256")
    .update(
      row.prevHash +
        row.id +
        row.skill +
        row.kind +
        row.actor +
        (row.before ?? "") +
        (row.after ?? "") +
        row.detail +
        (row.undoes ?? "") +
        row.createdAt,
    )
    .digest("hex");
}

function newMutationId(): string {
  return `mut_${randomBytes(8).toString("hex")}`;
}

/** Every row, oldest first. A missing ledger is no rows, not an error. */
export function readMutations(skillsDir: string, filter: { skill?: string } = {}): CuratorMutation[] {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath(skillsDir), "utf8");
  } catch {
    return [];
  }
  const rows: CuratorMutation[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      rows.push(JSON.parse(line) as CuratorMutation);
    } catch {
      // A truncated last line (a crash mid-append) is not a reason to lose the rows before it;
      // `verifyMutationChain` is what reports the file as damaged.
      continue;
    }
  }
  return filter.skill === undefined ? rows : rows.filter((r) => r.skill === filter.skill);
}

export function lastMutation(skillsDir: string): CuratorMutation | null {
  const rows = readMutations(skillsDir);
  return rows.length === 0 ? null : rows[rows.length - 1]!;
}

export interface AppendInput {
  skill: string;
  kind: CuratorMutationKind;
  actor: string;
  before: string | null;
  after: string | null;
  detail?: string;
  undoes?: string | null;
  now?: string;
}

/** Append one row, chained to whatever is currently last. Never rewrites what is there. */
export function appendMutation(skillsDir: string, input: AppendInput): CuratorMutation {
  const prev = lastMutation(skillsDir);
  const partial: Omit<CuratorMutation, "hash"> = {
    id: newMutationId(),
    skill: input.skill,
    kind: input.kind,
    actor: input.actor,
    before: input.before,
    after: input.after,
    detail: input.detail ?? "",
    undoes: input.undoes ?? null,
    createdAt: input.now ?? new Date().toISOString(),
    prevHash: prev === null ? GENESIS_HASH : prev.hash,
  };
  const row: CuratorMutation = { ...partial, hash: computeMutationHash(partial) };
  const file = ledgerPath(skillsDir);
  fs.mkdirSync(skillsDir, { recursive: true, mode: SKILL_DIR_MODE });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: SKILL_FILE_MODE });
  fs.chmodSync(file, SKILL_FILE_MODE);
  return row;
}

export type ChainVerdict = { ok: true; count: number } | { ok: false; line: number; reason: string };

/** Re-walk the chain. The 1-based line of the first row that does not hold is the answer. */
export function verifyMutationChain(skillsDir: string): ChainVerdict {
  const rows = readMutations(skillsDir);
  let prev = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const line = index + 1;
    if (row.prevHash !== prev) {
      return { ok: false, line, reason: `row ${row.id} links to ${row.prevHash}, not to its predecessor ${prev}` };
    }
    const { hash, ...rest } = row;
    if (computeMutationHash(rest) !== hash) {
      return { ok: false, line, reason: `row ${row.id} does not hash to ${hash}; its contents changed after it was written` };
    }
    prev = hash;
  }
  return { ok: true, count: rows.length };
}
