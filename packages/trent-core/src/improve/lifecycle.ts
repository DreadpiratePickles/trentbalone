/**
 * Item 5 of the loop — adopted from Hermes' curator: retirement, the ledger on every change, and
 * rollback. Plus the one door through which any artifact goes live: `promoteDraft`, human only.
 *
 * Staleness here is time-since-USE (a trace with `skillApplied`, or the promotion itself), not
 * time-since-view, and a listed skill is exempt. Degradation is a separate signal
 * (`skill-health.ts`, applied in the sweep) — the reference says keep it, so it is kept.
 */

import { applyMemoryBytes, decodeMemoryDraft } from "../fleet-memory/memory-draft.js";
import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";
import { distillCleanTrace, groupRowsByRun, rawTraceFromRows, type CleanGolden } from "./clean-trace.js";
import { frozenRefusalMessage, frozenViolations, type FrozenSurface } from "./frozen-surface.js";
import { FROZEN_REFUSAL_ACTOR } from "./frozen-surface.js";
import { contentHash, judgeAgreementFor, newId, nowIso, recordLedger } from "./ledger.js";
import { SweepMeter } from "./meter.js";
import { ProtectedPromptError } from "./protected-prompt.js";
import { rationaliseGolden, type ExemplarStore, type RationaleFn } from "./rationalise.js";
// [D5] a promoted tool draft is a description on disk; a rollback takes it back off.
import { decodeToolDraft } from "./tool-drafts.js";
import { TOOL_OVERRIDES_FILE, removeToolOverride, writeToolOverride } from "./tool-overrides.js";

/** Tasks I.13 and I.14: where a promotion's clean exemplars go, and the model that explains them. */
export interface DistillOnPromote {
  readonly exemplars: ExemplarStore;
  /** Omit to distil without a rationale (no model call). */
  readonly rationalise?: RationaleFn;
  /** Counts the rationale calls under the `rationalise` phase. A fresh unbudgeted meter when omitted. */
  readonly meter?: SweepMeter;
  readonly onError?: (message: string) => void;
}

export interface PromoteOptions {
  readonly actor: string;
  /**
   * [D0] gate 1: the frozen surface, checked at the promotion door as well as at the draft's.
   * A draft that reached quarantine by another path (a memory delta, a hand-written row) is
   * refused here with the path named, and the refusal is ledgered. Omit and nothing is enforced.
   */
  readonly frozen?: FrozenSurface;
  /** The iteration that produced the draft; found from the draft id when omitted. */
  readonly iterationId?: string;
  readonly now?: string;
  readonly distill?: DistillOnPromote;
  /**
   * [D5] Where a promoted `tool` draft's description is written (`<profileDir>/tool-overrides.json`).
   * Required for that kind and ignored for every other: a tool promotion that only changed a row
   * in the database would leave the seats reading the shipped description for ever.
   */
  readonly toolOverrides?: { readonly profileDir: string };
}

/**
 * [D5] The description a promoted tool draft puts in front of every later `buildTrentTools`. The
 * draft's own bytes are the source; nothing is re-derived from the traces at promotion time.
 */
function applyToolPromotion(draft: SkillDraftRow, options: PromoteOptions, now: string): void {
  const profileDir = options.toolOverrides?.profileDir;
  if (profileDir === undefined) {
    throw new ProtectedPromptError(`refusing to promote tool draft ${draft.id}: no profile directory was given to write ${TOOL_OVERRIDES_FILE} in`);
  }
  const payload = decodeToolDraft(draft.content);
  if (!payload) throw new Error(`tool draft ${draft.id} does not carry a description to promote`);
  writeToolOverride(profileDir, { tool: payload.tool, description: payload.proposedDescription, draftId: draft.id, promotedAt: now });
}

export interface DistillReport {
  goldens: CleanGolden[];
  /** Runs that were not clean (blocked, or did not finish on a successful step). */
  skippedRuns: string[];
  rationaleCalls: number;
}

/**
 * Task I.13: every run of the promoted draft's (agent, taskType) that is clean on process and
 * outcome becomes one exemplar of its successful steps only; a blocked run never does. Task I.14:
 * each exemplar is rationalised once, content-addressed on its step list. Never throws: a failed
 * distillation is reported, and the promotion it followed stands.
 */
export async function distillExemplars(store: ImproveStorePort, draft: SkillDraftRow, options: DistillOnPromote, now: string): Promise<DistillReport> {
  const meter = options.meter ?? new SweepMeter(undefined);
  const report: DistillReport = { goldens: [], skippedRuns: [], rationaleCalls: 0 };
  const rows = await store.listTraces(draft.companyId, { agentId: draft.agentId, taskType: draft.taskType });
  for (const [runId, runRows] of groupRowsByRun(rows)) {
    const golden = distillCleanTrace(rawTraceFromRows(runRows), { candidateId: draft.id, now });
    if (!golden) {
      report.skippedRuns.push(runId);
      continue;
    }
    try {
      if (options.rationalise) {
        const before = meter.phases.rationalise.calls;
        const { golden: stored } = await rationaliseGolden(golden, { ask: options.rationalise, meter, store: options.exemplars });
        report.rationaleCalls += meter.phases.rationalise.calls - before;
        report.goldens.push(stored);
      } else {
        await options.exemplars.put(golden);
        report.goldens.push(golden);
      }
    } catch (error) {
      options.onError?.(`exemplar for run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
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
  if (options.frozen) {
    const violations = frozenViolations(draft, options.frozen);
    if (violations.length > 0) {
      // The draft is NOT rejected here: a human asked for something the loop may not do, and the
      // refusal is the answer. The ledger row is what makes the attempt visible in `history`.
      await recordLedger(store, { action: "reject", artifact: draft, before: null, after: null, iterationId: null, actor: FROZEN_REFUSAL_ACTOR, now });
      throw new ProtectedPromptError(`refusing to promote ${draft.kind} draft ${draftId}: ${frozenRefusalMessage(violations)}`);
    }
  }
  // [D5] The disk write goes first, like the memory rollback's: a refused write leaves the draft
  // in quarantine and the ledger untouched, rather than a live row nothing serves.
  if (draft.kind === "tool") applyToolPromotion(draft, options, now);
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
  if (options.distill) await distillExemplars(store, promoted, options.distill, now);
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
export interface RollbackOptions {
  /** [D5] Where the tool-description overrides live; without it a `tool` row is reversed in the store only. */
  readonly profileDir?: string;
}

/** [D5] The shipped description comes back: the prior promotion's bytes, or no override at all. */
function rollbackToolOverride(before: string | null, profileDir: string | undefined, tool: string, now: string): void {
  if (profileDir === undefined) return;
  const prior = before === null ? undefined : decodeToolDraft(before);
  if (prior === undefined) {
    removeToolOverride(profileDir, tool);
    return;
  }
  writeToolOverride(profileDir, { tool: prior.tool, description: prior.proposedDescription, draftId: `restored:${prior.tool}`, promotedAt: now });
}

export async function rollback(
  store: ImproveStorePort,
  iterationId: string,
  actor: string,
  now = nowIso(),
  options: RollbackOptions = {},
): Promise<RollbackReport> {
  const iteration = await store.getIteration(iterationId);
  if (!iteration) throw new Error(`iteration ${iterationId} not found`);
  const rows = (await store.listLedger(iteration.companyId, { iterationId })).filter((row) => row.action === "promote" || row.action === "fix");
  if (rows.length === 0) throw new Error(`iteration ${iterationId} promoted nothing; there is nothing to roll back`);

  const report: RollbackReport = { iterationId, reverted: [], restored: [] };
  for (const row of [...rows].reverse()) {
    // An agent version (T4.1) is a label flip, not bytes: `after` is the promoted version id and
    // `before` the one it archived. Neither ever lived in the SkillDraft table.
    if (row.artifactKind === "agent") {
      await store.updateAgentVersion(row.artifactId, { label: "archived" });
      report.reverted.push(row.artifactId);
      if (row.before !== null) {
        await store.updateAgentVersion(row.before, { label: "live" });
        report.restored.push({ artifactId: row.before, taskType: row.taskType });
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
      continue;
    }
    // A memory artifact lives on disk as well as in the row: put the prior bytes back first, so a
    // refused file write (over the cap, or locked by a writer) leaves the ledger untouched.
    if (row.artifactKind === "memory" && row.before !== null) {
      const prior = decodeMemoryDraft(row.before);
      applyMemoryBytes(prior.profileDir, prior);
    }
    // [D5] Same order for a tool: the file first, so the seats stop reading a reverted description
    // even if the store update below fails. `taskType` is the tool name.
    if (row.artifactKind === "tool") rollbackToolOverride(row.before, options.profileDir, row.taskType, now);
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
