/**
 * `trent improve status` — what the loop knows right now, as data. Traces per agent, drafts in
 * quarantine, the last sweep, each agent's frontier best, whether an agent's suite is saturated
 * (task I.10), the running judge-versus-human agreement rate (task I.8), and the two failure-mode
 * counters: gate rejections for a repetitive loop (I.15, plus the traces carrying the tag) and for
 * a private regression (I.16). Reads only.
 */

import type { ImproveStorePort, IterationRow, SkillDraftRow, SkillLedgerRow } from "../store/StorePort.js";
import { SUITE_SATURATED } from "./gepa-pass.js";
import { SEAT_PROMPT_TASK_TYPE } from "./protected-prompt.js";
import { isRepetitiveLoopTag } from "./repetitive-loop.js";

export interface QuarantineEntry {
  id: string;
  agentId: string;
  taskType: string;
  kind: SkillDraftRow["kind"];
  triggers: string[];
  createdAt: string;
  /** The gate's decision for this draft, when it was gated. */
  gate: { decision: string; score: number | null; delta: number | null; blockedBy: string | null } | null;
}

export interface FrontierBest {
  candidateId: string;
  score: number;
  delta: number;
  candidates: number;
  updatedAt: string;
}

/** How often the gate's verdict matched the human's decision, over every human promote/reject that was gated. */
export interface JudgeAgreement {
  agreed: number;
  disagreed: number;
  /** agreed / (agreed + disagreed), two decimals; null until a gated human decision exists. */
  rate: number | null;
}

export interface ImproveStatus {
  companyId: string;
  tracesPerAgent: Record<string, number>;
  quarantine: QuarantineEntry[];
  live: Array<{ id: string; agentId: string; taskType: string; kind: SkillDraftRow["kind"]; promotedAt: string | null }>;
  lastSweep: { at: string; iterations: number } | null;
  frontierBest: Record<string, FrontierBest>;
  /** Agents whose last GEPA pass found the baseline at 1.0: the suite can teach them nothing. */
  suiteSaturated: Record<string, boolean>;
  judgeAgreement: JudgeAgreement;
  /** Candidates the gate refused because their fixture run looped on one tool (I.15). */
  repetitiveLoops: number;
  /** Traces on record that carry a `repetitive_loop:<tool>` tag (I.15). */
  repetitiveLoopTraces: number;
  /** Candidates the gate refused because they regressed a held-out private fixture (I.16). */
  privateRegressions: number;
}

export function judgeAgreementOf(ledger: readonly SkillLedgerRow[]): JudgeAgreement {
  let agreed = 0;
  let disagreed = 0;
  for (const row of ledger) {
    if (row.judgeAgreement === true) agreed += 1;
    else if (row.judgeAgreement === false) disagreed += 1;
  }
  const total = agreed + disagreed;
  return { agreed, disagreed, rate: total === 0 ? null : Math.round((agreed / total) * 100) / 100 };
}

/** Per agent, whether the LATEST seat-prompt iteration was a saturation skip. */
function saturationOf(iterations: readonly IterationRow[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of iterations) {
    if (row.taskType !== SEAT_PROMPT_TASK_TYPE || row.agentId in out) continue;
    out[row.agentId] = row.blockedBy === SUITE_SATURATED;
  }
  return out;
}

function blockedCount(iterations: readonly IterationRow[], reason: string): number {
  return iterations.filter((i) => i.blockedBy === reason).length;
}

function gateOf(iterations: readonly IterationRow[], draftId: string): QuarantineEntry["gate"] {
  const row = iterations.find((i) => i.candidateId === draftId);
  return row ? { decision: row.decision, score: row.score, delta: row.delta, blockedBy: row.blockedBy } : null;
}

export async function improveStatus(store: ImproveStorePort, companyId: string): Promise<ImproveStatus> {
  const [tracesPerAgent, quarantine, live, iterations, ledger, traces] = await Promise.all([
    store.countTracesByAgent(companyId),
    store.listDrafts(companyId, { status: "quarantine" }),
    store.listDrafts(companyId, { status: "live" }),
    store.listIterations(companyId),
    store.listLedger(companyId),
    store.listTraces(companyId),
  ]);

  const latest = iterations[0];
  const lastSweep = latest ? { at: latest.createdAt, iterations: iterations.filter((i) => i.createdAt === latest.createdAt).length } : null;

  const frontierBest: Record<string, FrontierBest> = {};
  const agents = new Set<string>([...Object.keys(tracesPerAgent), ...iterations.filter((i) => i.taskType === SEAT_PROMPT_TASK_TYPE).map((i) => i.agentId)]);
  for (const agentId of agents) {
    const row = await store.getFrontier(companyId, agentId);
    const best = row?.frontier.best;
    const candidates = row?.frontier.candidates;
    if (!best || typeof best !== "object" || Array.isArray(best)) continue;
    frontierBest[agentId] = {
      candidateId: String(best.id ?? ""),
      score: Number(best.score ?? 0),
      delta: Number(best.delta ?? 0),
      candidates: Array.isArray(candidates) ? candidates.length : 0,
      updatedAt: row?.updatedAt ?? "",
    };
  }

  return {
    companyId,
    tracesPerAgent,
    quarantine: quarantine.map((d) => ({
      id: d.id,
      agentId: d.agentId,
      taskType: d.taskType,
      kind: d.kind,
      triggers: d.triggers,
      createdAt: d.createdAt,
      gate: gateOf(iterations, d.id),
    })),
    live: live.map((d) => ({ id: d.id, agentId: d.agentId, taskType: d.taskType, kind: d.kind, promotedAt: d.promotedAt })),
    lastSweep,
    frontierBest,
    suiteSaturated: saturationOf(iterations),
    judgeAgreement: judgeAgreementOf(ledger),
    repetitiveLoops: blockedCount(iterations, "repetitive_loop"),
    repetitiveLoopTraces: traces.filter((t) => (t.failureTags ?? []).some(isRepetitiveLoopTag)).length,
    privateRegressions: blockedCount(iterations, "private_regression"),
  };
}
