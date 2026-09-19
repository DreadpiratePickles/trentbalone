/**
 * [D3] The curator's vocabulary: what a mutation is, who made it, and the two clocks.
 *
 * This is the first cut of Hermes' curator. What is deliberately absent is the LLM consolidation
 * pass that folds several skills into an umbrella skill: SkillAxe measured raw LLM-authored
 * skills at zero gain, so the loop that would write them is not worth its cost or its risk.
 */
import type { SkillProvenance, SkillStatus } from "../skills/skill-store.js";

/**
 * Every kind of change one row can record.
 *   create/edit/delete  a write through `skill_manage` or the CLI
 *   age/archive         the curator's own time-based transitions
 *   quarantine/promote  the composed-skill scan gate, and the human release that clears it
 *   adopt               a declared change of provenance
 *   restore             an archived skill brought back
 *   undo                the reversal of exactly one earlier mutation
 */
export type CuratorMutationKind =
  | "create"
  | "edit"
  | "delete"
  | "age"
  | "archive"
  | "restore"
  | "quarantine"
  | "promote"
  | "adopt"
  | "undo";

export const CURATOR_MUTATION_KINDS: readonly CuratorMutationKind[] = [
  "create",
  "edit",
  "delete",
  "age",
  "archive",
  "restore",
  "quarantine",
  "promote",
  "adopt",
  "undo",
];

/** The curator's own actor name. Everything else is a seat id or `human`. */
export const CURATOR_ACTOR = "curator";
export const HUMAN_ACTOR = "human";

/** Hermes ages at 14 and 30 days; a fleet's skills are used far less often than a chat's. */
export const DEFAULT_STALE_AFTER_DAYS = 60;
export const DEFAULT_ARCHIVE_AFTER_DAYS = 180;

export const DAY_MS = 86_400_000;

/** One row of the append-only ledger, exactly as it is serialised. */
export interface CuratorMutation {
  id: string;
  skill: string;
  kind: CuratorMutationKind;
  actor: string;
  /** sha256 of the skill's bytes before the change; null when it did not exist. */
  before: string | null;
  /** sha256 of the bytes after; null when the skill was removed. */
  after: string | null;
  /** Why, in one line: the status transition, the scan findings, the provenance change. */
  detail: string;
  /** The mutation this row reverses, for an `undo` row; null otherwise. */
  undoes: string | null;
  createdAt: string;
  prevHash: string;
  hash: string;
}

/** One skill as the curator reports it. */
export interface CuratorSkillRow {
  skill: string;
  status: SkillStatus;
  createdBy: SkillProvenance;
  /** Days since the last load, measured from `promoted_at` when nothing has loaded it. */
  idleDays: number;
  useCount: number;
  lastUsedAt: string | null;
  /** Whether the curator may age or archive this skill at all. */
  eligible: boolean;
  quarantineReason: string | null;
}

/** What a curator call needs to reach the store and to be deterministic under test. */
export interface CuratorContext {
  skillsDir: string;
  now?: string;
  actor?: string;
}
