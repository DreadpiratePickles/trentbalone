/**
 * [D3] The curator proper: aging by time-since-load, declared provenance as the autonomy policy,
 * and the composed-skill scan gate that stands between an agent's write and `active`.
 *
 * Two rules run through all of it. Provenance is declared, never inferred: only `created_by:
 * agent` skills are the curator's to age, and a human's or an imported skill is reported however
 * old it gets. And nothing is ever deleted — `stale` and `archived` are states of a skill that is
 * still on disk, and every transition is a ledger row with the bytes on both sides of it.
 */
import fs from "node:fs";
import path from "node:path";

import { SecurityScan } from "../skills/SecurityScan.js";
import {
  BUNDLE_DIRS,
  findSkillRecord,
  isCuratable,
  listSkillRecords,
  readSkillDocument,
  updateSkillMeta,
  type SkillProvenance,
  type SkillRecord,
  type SkillStatus,
} from "../skills/skill-store.js";
import { appendMutation, putSkillBlob, readMutations, verifyMutationChain } from "./ledger.js";
import {
  CURATOR_ACTOR,
  DAY_MS,
  DEFAULT_ARCHIVE_AFTER_DAYS,
  DEFAULT_STALE_AFTER_DAYS,
  HUMAN_ACTOR,
  type CuratorMutation,
  type CuratorMutationKind,
  type CuratorSkillRow,
} from "./types.js";

export interface CuratorCall {
  skillsDir: string;
  now?: string;
  actor?: string;
}

export interface AgeOptions extends CuratorCall {
  staleAfterDays?: number;
  archiveAfterDays?: number;
}

export interface AgeReport {
  stale: string[];
  archived: string[];
  kept: string[];
  /** Skills the curator is not allowed to touch, named with why. Reported, never aged. */
  reported: CuratorSkillRow[];
}

/** Days since the last load, falling back to when the skill entered the store, then to its file. */
export function idleDays(record: SkillRecord, now: string): number {
  const baseline = record.lastUsedAt ?? record.promotedAt ?? fileBaseline(record.file);
  const ms = Date.parse(now) - Date.parse(baseline);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / DAY_MS)) : 0;
}

function fileBaseline(file: string): string {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function toRow(record: SkillRecord, now: string): CuratorSkillRow {
  return {
    skill: record.name,
    status: record.status,
    createdBy: record.createdBy,
    idleDays: idleDays(record, now),
    useCount: record.useCount,
    lastUsedAt: record.lastUsedAt,
    eligible: isCuratable(record) && record.status !== "quarantined",
    quarantineReason: record.quarantineReason,
  };
}

/** Write a status transition and ledger it with the document on both sides. */
function transition(
  skillsDir: string,
  record: SkillRecord,
  kind: CuratorMutationKind,
  next: SkillStatus,
  detail: string,
  actor: string,
  now: string,
): CuratorMutation {
  const before = putSkillBlob(skillsDir, readSkillDocument(record));
  const after = putSkillBlob(
    skillsDir,
    updateSkillMeta(record, { status: next, ...(next === "quarantined" ? {} : { quarantine_reason: null }) }),
  );
  return appendMutation(skillsDir, { skill: record.name, kind, actor, before, after, detail, now });
}

/**
 * The aging pass. `trent curator age` calls it; a heartbeat tick may call exactly this function
 * later, which is why the thresholds and the clock are arguments and nothing here reads config.
 */
export function ageSkills(options: AgeOptions): AgeReport {
  const { skillsDir } = options;
  const now = options.now ?? new Date().toISOString();
  const actor = options.actor ?? CURATOR_ACTOR;
  const staleAfter = options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const archiveAfter = options.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS;
  const report: AgeReport = { stale: [], archived: [], kept: [], reported: [] };

  for (const record of listSkillRecords(skillsDir)) {
    const row = toRow(record, now);
    if (!row.eligible) {
      report.reported.push(row);
      continue;
    }
    if (record.status === "archived") {
      report.kept.push(record.name);
      continue;
    }
    const idle = row.idleDays;
    if (idle >= archiveAfter) {
      transition(skillsDir, record, "archive", "archived", `${record.status} to archived after ${idle} idle days`, actor, now);
      report.archived.push(record.name);
    } else if (idle >= staleAfter && record.status === "active") {
      transition(skillsDir, record, "age", "stale", `active to stale after ${idle} idle days`, actor, now);
      report.stale.push(record.name);
    } else if (record.status === "stale") {
      // A fresh load is the answer to staleness: the skill is in use again, so it is active again.
      transition(skillsDir, record, "restore", "active", `stale to active after a load ${idle} days ago`, actor, now);
      report.kept.push(record.name);
    } else {
      report.kept.push(record.name);
    }
  }
  return report;
}

function mustFind(skillsDir: string, name: string): SkillRecord {
  const record = findSkillRecord(skillsDir, name);
  if (record === null) throw new Error(`skill "${name}" is not in this profile's store`);
  if (record.dir === null) {
    throw new Error(`skill "${name}" is a legacy flat file the store could not migrate; rename it to a valid skill name first`);
  }
  return record;
}

export interface AdoptResult {
  skill: string;
  createdBy: SkillProvenance;
  previous: SkillProvenance;
  mutation: CuratorMutation;
}

/**
 * Declare a skill the curator's to manage. This is the ONLY way provenance changes: nothing
 * infers it from how often a skill is used or who happened to write it last.
 */
export function adoptSkill(options: CuratorCall & { name: string; provenance?: SkillProvenance }): AdoptResult {
  const { skillsDir, name } = options;
  const now = options.now ?? new Date().toISOString();
  const actor = options.actor ?? HUMAN_ACTOR;
  const next = options.provenance ?? "agent";
  const record = mustFind(skillsDir, name);
  if (record.createdBy === next) {
    throw new Error(`skill "${name}" is already declared ${next}`);
  }
  const before = putSkillBlob(skillsDir, readSkillDocument(record));
  const after = putSkillBlob(skillsDir, updateSkillMeta(record, { created_by: next }));
  const mutation = appendMutation(skillsDir, {
    skill: name,
    kind: "adopt",
    actor,
    before,
    after,
    detail: `provenance ${record.createdBy} to ${next}`,
    now,
  });
  return { skill: name, createdBy: next, previous: record.createdBy, mutation };
}

export interface ReleaseResult {
  skill: string;
  status: SkillStatus;
  previous: SkillStatus;
  mutation: CuratorMutation;
}

/**
 * The human's door back to `active`: out of quarantine, or out of the archive. A skill that is
 * already advertised has nothing to release, and saying so is more useful than a silent no-op.
 */
export function releaseSkill(options: CuratorCall & { name: string }): ReleaseResult {
  const { skillsDir, name } = options;
  const now = options.now ?? new Date().toISOString();
  const actor = options.actor ?? HUMAN_ACTOR;
  const record = mustFind(skillsDir, name);
  if (record.status !== "quarantined" && record.status !== "archived") {
    throw new Error(`skill "${name}" is ${record.status}; only a quarantined or archived skill is released`);
  }
  const kind: CuratorMutationKind = record.status === "quarantined" ? "promote" : "restore";
  const detail =
    record.status === "quarantined"
      ? `released from quarantine (${record.quarantineReason ?? "no reason recorded"})`
      : "restored from the archive";
  const mutation = transition(skillsDir, record, kind, "active", detail, actor, now);
  return { skill: name, status: "active", previous: record.status, mutation };
}

export interface CuratorStatusReport {
  skills: CuratorSkillRow[];
  counts: Record<"total" | "active" | "stale" | "archived" | "quarantined" | "eligible", number>;
  ledger: { count: number; verified: boolean; reason: string | null };
  thresholds: { staleAfterDays: number; archiveAfterDays: number };
}

export function curatorStatus(options: AgeOptions): CuratorStatusReport {
  const { skillsDir } = options;
  const now = options.now ?? new Date().toISOString();
  const skills = listSkillRecords(skillsDir).map((record) => toRow(record, now));
  const count = (status: SkillStatus): number => skills.filter((s) => s.status === status).length;
  const verdict = verifyMutationChain(skillsDir);
  return {
    skills,
    counts: {
      total: skills.length,
      active: count("active"),
      stale: count("stale"),
      archived: count("archived"),
      quarantined: count("quarantined"),
      eligible: skills.filter((s) => s.eligible).length,
    },
    ledger: {
      count: readMutations(skillsDir).length,
      verified: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
    },
    thresholds: {
      staleAfterDays: options.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
      archiveAfterDays: options.archiveAfterDays ?? DEFAULT_ARCHIVE_AFTER_DAYS,
    },
  };
}

/**
 * The gate's input: the whole skill as a seat would receive it — its document and every file in
 * its bundle. No single `skill_manage` operation ever sees this much, which is the point: text
 * that is harmless one write at a time is scanned here as the composed thing it became.
 */
export function composeSkill(record: SkillRecord): string {
  const parts = [readSkillDocument(record)];
  if (record.dir !== null) {
    for (const sub of BUNDLE_DIRS) {
      const dir = path.join(record.dir, sub);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          parts.push(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        } catch {
          continue;
        }
      }
    }
  }
  return parts.join("\n");
}

export interface SkillWriteRecord {
  skillsDir: string;
  name: string;
  actor: string;
  kind: Extract<CuratorMutationKind, "create" | "edit" | "delete">;
  /** The document before the write; null when the skill did not exist. */
  before: string | null;
  /** Run the composed-skill gate. True for a write an agent made. */
  gate: boolean;
  detail?: string;
  now?: string;
}

export interface SkillWriteResult {
  mutation: CuratorMutation;
  /** The quarantine row, when the gate flagged the composed skill. */
  quarantine: CuratorMutation | null;
  findings: string[];
}

/**
 * Ledger one write to one skill, then — for an agent's write — put the composed skill through the
 * scan gate. A flagged skill is not rolled back and not deleted: it sits `quarantined` with the
 * reason, is not advertised to any seat, and waits for `trent curator release`.
 */
export function recordSkillWrite(input: SkillWriteRecord): SkillWriteResult {
  const { skillsDir, name } = input;
  const now = input.now ?? new Date().toISOString();
  const record = input.kind === "delete" ? null : findSkillRecord(skillsDir, name);
  const mutation = appendMutation(skillsDir, {
    skill: name,
    kind: input.kind,
    actor: input.actor,
    before: input.before === null ? null : putSkillBlob(skillsDir, input.before),
    after: record === null ? null : putSkillBlob(skillsDir, readSkillDocument(record)),
    detail: input.detail ?? "",
    now,
  });
  if (!input.gate || record === null || record.status === "quarantined") {
    return { mutation, quarantine: null, findings: [] };
  }
  const scan = SecurityScan.scan(composeSkill(record));
  if (scan.safe) return { mutation, quarantine: null, findings: [] };
  const reason = scan.findings.join("; ");
  const before = putSkillBlob(skillsDir, readSkillDocument(record));
  const after = putSkillBlob(skillsDir, updateSkillMeta(record, { status: "quarantined", quarantine_reason: reason }));
  const quarantine = appendMutation(skillsDir, {
    skill: name,
    kind: "quarantine",
    actor: CURATOR_ACTOR,
    before,
    after,
    detail: `composed-skill scan (score ${scan.score}): ${reason}`,
    now,
  });
  return { mutation, quarantine, findings: scan.findings };
}
