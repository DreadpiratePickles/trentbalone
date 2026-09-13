/**
 * Item 5 of the loop — adopted from Hermes' curator: retirement, the ledger on every change, and
 * rollback. Plus the one door through which any artifact goes live: `promoteDraft`, human only.
 *
 * Staleness here is time-since-USE (a trace with `skillApplied`, or the promotion itself), not
 * time-since-view, and a listed skill is exempt. Degradation is a separate signal
 * (`skill-health.ts`, applied in the sweep) — the reference says keep it, so it is kept.
 */

import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";
import { contentHash, judgeAgreementFor, newId, nowIso, recordLedger } from "./ledger.js";
import { ProtectedPromptError } from "./protected-prompt.js";

export interface PromoteOptions {
  readonly actor: string;
  /** The iteration that produced the draft; found from the draft id when omitted. */
  readonly iterationId?: string;
  readonly now?: string;
}

async function iterationFor(store: ImproveStorePort, draft: SkillDraftRow): Promise<string | null> {
  const rows = await store.listIterations(draft.companyId, { agentId: draft.agentId });
  return rows.find((row) => row.candidateId === draft.id)?.id ?? null;
}

async function currentLive(store: ImproveStorePort, draft: SkillDraftRow): Promise<SkillDraftRow | undefined> {
  const live = await store.listDrafts(draft.companyId, { agentId: draft.agentId, taskType: draft.taskType, kind: draft.kind, status: "live" });
  return live.find((row) => row.id !== draft.id);
}

/**
 * Quarantine -> live. Only a human may call this — for a skill and, above all, for a seat prompt.
 * A live predecessor for the same (agent, taskType, kind) is archived, never deleted, and the
 * ledger row is a `fix` carrying its bytes; otherwise the row is a plain `promote`.
 */
export async function promoteDraft(store: ImproveStorePort, draftId: string, options: PromoteOptions): Promise<SkillDraftRow> {
  const draft = await store.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (options.actor !== "human") {
    throw new ProtectedPromptError(`refusing to promote ${draft.kind} draft ${draftId}: actor "${options.actor}" is not a human command`);
  }
  if (draft.status === "live") return draft;

  const now = options.now ?? nowIso();
  const iterationId = options.iterationId ?? (await iterationFor(store, draft));
  const prior = await currentLive(store, draft);
  if (prior) {
    await store.updateDraft(prior.id, { status: "archived", retiredAt: now });
  }
  const promoted = await store.updateDraft(draft.id, { status: "live", promotedAt: now, lastUsedAt: now, retiredAt: null });
  await recordLedger(store, {
    action: prior ? "fix" : "promote",
    artifact: promoted,
    before: prior?.content ?? null,
    after: promoted.content,
    iterationId,
    actor: options.actor,
    judgeAgreement: await judgeAgreementFor(store, iterationId, true),
    now,
  });
  return promoted;
}

/** Quarantine (or live) -> rejected, with a ledger row. Idempotent. */
export async function rejectDraft(store: ImproveStorePort, draftId: string, actor: string, now = nowIso()): Promise<SkillDraftRow> {
  const draft = await store.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status === "rejected") return draft;
  const rejected = await store.updateDraft(draft.id, { status: "rejected", retiredAt: now });
  const iterationId = await iterationFor(store, draft);
  await recordLedger(store, {
    action: "reject",
    artifact: rejected,
    before: draft.status === "live" ? draft.content : null,
    after: null,
    iterationId,
    actor,
    // Only a human decision measures the judge; the sweep's own rejections are the judge.
    judgeAgreement: actor === "human" ? await judgeAgreementFor(store, iterationId, false) : null,
    now,
  });
  return rejected;
}

export interface RetirementOptions {
  readonly now?: string;
  /** Days unused before a live skill is marked stale. Hermes: 14. */
  readonly staleAfterDays?: number;
  /** Days unused before a stale skill is archived. Hermes: 30. */
  readonly archiveAfterDays?: number;
  /** Task types that are explicitly listed (granted to an agent); never retired by time. */
  readonly listed?: ReadonlySet<string>;
}

export interface RetirementReport {
  stale: string[];
  archived: string[];
  kept: string[];
}

const DAY_MS = 86_400_000;

/** Time-based retirement of live skills. Both states are recoverable with `recoverDraft`. */
export async function retireSkills(store: ImproveStorePort, companyId: string, options: RetirementOptions = {}): Promise<RetirementReport> {
  const now = options.now ?? nowIso();
  const staleAfter = options.staleAfterDays ?? 14;
  const archiveAfter = options.archiveAfterDays ?? 30;
  const listed = options.listed ?? new Set<string>();
  const report: RetirementReport = { stale: [], archived: [], kept: [] };

  const candidates = [
    ...(await store.listDrafts(companyId, { kind: "skill", status: "live" })),
    ...(await store.listDrafts(companyId, { kind: "skill", status: "stale" })),
  ];
  for (const draft of candidates) {
    if (listed.has(draft.taskType)) {
      report.kept.push(draft.id);
      continue;
    }
    const lastUsed = draft.lastUsedAt ?? draft.promotedAt ?? draft.createdAt;
    const ageDays = (new Date(now).getTime() - new Date(lastUsed).getTime()) / DAY_MS;
    if (ageDays >= archiveAfter) {
      await store.updateDraft(draft.id, { status: "archived", retiredAt: now });
      await recordLedger(store, { action: "archive", artifact: draft, before: draft.content, after: null, iterationId: null, actor: "curator", now });
      report.archived.push(draft.id);
    } else if (ageDays >= staleAfter && draft.status !== "stale") {
      await store.updateDraft(draft.id, { status: "stale", retiredAt: now });
      await recordLedger(store, { action: "retire", artifact: draft, before: draft.content, after: draft.content, iterationId: null, actor: "curator", now });
      report.stale.push(draft.id);
    } else if (draft.status === "stale") {
      report.stale.push(draft.id);
    } else {
      report.kept.push(draft.id);
    }
  }
  return report;
}

/** Stale or archived -> live again, with a ledger row. */
export async function recoverDraft(store: ImproveStorePort, draftId: string, actor: string, now = nowIso()): Promise<SkillDraftRow> {
  const draft = await store.getDraft(draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (draft.status !== "stale" && draft.status !== "archived") {
    throw new Error(`draft ${draftId} is ${draft.status}; only stale or archived drafts are recovered`);
  }
  const recovered = await store.updateDraft(draft.id, { status: "live", retiredAt: null, lastUsedAt: now });
  await recordLedger(store, { action: "recover", artifact: recovered, before: null, after: recovered.content, iterationId: null, actor, now });
  return recovered;
}

export interface RollbackReport {
  iterationId: string;
  /** Candidates un-promoted (now rejected). */
  reverted: string[];
  /** Prior artifacts restored byte-for-byte. */
  restored: Array<{ artifactId: string; taskType: string }>;
}

/**
 * `rollback <iterationId>`: every promote/fix the iteration produced is reversed. The promoted
 * candidate becomes rejected; the artifact it replaced is restored from the ledger's `before`
 * bytes — into the archived row when it is still there, or into a fresh row when it is not —
 * and the restoration is itself a ledger row.
 */
export async function rollback(store: ImproveStorePort, iterationId: string, actor: string, now = nowIso()): Promise<RollbackReport> {
  const iteration = await store.getIteration(iterationId);
  if (!iteration) throw new Error(`iteration ${iterationId} not found`);
  const rows = (await store.listLedger(iteration.companyId, { iterationId })).filter((row) => row.action === "promote" || row.action === "fix");
  if (rows.length === 0) throw new Error(`iteration ${iterationId} promoted nothing; there is nothing to roll back`);

  const report: RollbackReport = { iterationId, reverted: [], restored: [] };
  for (const row of [...rows].reverse()) {
    const candidate = await store.getDraft(row.artifactId);
    if (candidate && candidate.status !== "rejected") {
      await store.updateDraft(candidate.id, { status: "rejected", retiredAt: now });
      report.reverted.push(candidate.id);
    }
    if (row.before !== null) {
      const archived = (await store.listDrafts(row.companyId, { agentId: row.agentId, taskType: row.taskType, kind: row.artifactKind, status: "archived" })).find(
        (d) => d.contentHash === row.beforeHash,
      );
      let restoredId: string;
      if (archived) {
        await store.updateDraft(archived.id, { status: "live", content: row.before, contentHash: contentHash(row.before), retiredAt: null, lastUsedAt: now });
        restoredId = archived.id;
      } else {
        restoredId = newId("skill");
        await store.createDraft({
          id: restoredId,
          companyId: row.companyId,
          agentId: row.agentId,
          taskType: row.taskType,
          kind: row.artifactKind,
          status: "live",
          content: row.before,
          contentHash: contentHash(row.before),
          triggers: [],
          createdAt: now,
          promotedAt: now,
          lastUsedAt: now,
          retiredAt: null,
        });
      }
      report.restored.push({ artifactId: restoredId, taskType: row.taskType });
    }
    await recordLedger(store, {
      action: "rollback",
      artifact: { id: row.artifactId, companyId: row.companyId, agentId: row.agentId, taskType: row.taskType, kind: row.artifactKind },
      before: row.after,
      after: row.before,
      iterationId,
      actor,
      now,
    });
  }
  return report;
}

/** The live skills an agent runs with, oldest task type first. */
export async function readLiveSkills(store: ImproveStorePort, companyId: string, agentId: string): Promise<Array<{ taskType: string; content: string }>> {
  const live = await store.listDrafts(companyId, { agentId, kind: "skill", status: "live" });
  return live.map((d) => ({ taskType: d.taskType, content: d.content })).sort((a, b) => a.taskType.localeCompare(b.taskType));
}
