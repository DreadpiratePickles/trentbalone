/**
 * The behavioural contract every `ImproveStorePort` must satisfy, written as a scenario that
 * returns plain data. The in-memory store runs it under vitest; the SQLite store runs it under
 * Bun (bun:sqlite has no Node equivalent) via `sqlite-scenario.ts`, and the same assertions are
 * applied to both results. One contract, two runtimes, no stand-in driver.
 */

import type { ImproveStorePort } from "../store/StorePort.js";

export interface StoreContractResult {
  tracesForAgent: number;
  tracesForOtherAgent: number;
  tracesForTaskType: number;
  tracesByRun: number;
  countsByAgent: Record<string, number>;
  draftAfterUpdate: { status: string; promotedAt: string | null; content: string } | null;
  quarantineDrafts: number;
  iterationsNewestFirst: string[];
  iterationByIdDecision: string | null;
  frontierRoundTrip: unknown;
  frontierMissing: boolean;
  ledgerForIteration: number;
  ledgerBeforeBytes: string | null;
  /** I.3: the gate cache round-trips JSON, overwrites on the same key, and misses cleanly. */
  gateCacheRoundTrip: unknown;
  gateCacheOtherCompany: unknown;
  gateCacheMissing: boolean;
}

export async function runStoreContract(store: ImproveStorePort): Promise<StoreContractResult> {
  const companyId = "co_contract";
  const t0 = "2026-09-12T10:00:00.000Z";
  const t1 = "2026-09-12T10:00:01.000Z";

  const trace = (id: string, agentId: string, taskType: string, runId: string, createdAt: string) => ({
    id,
    companyId,
    agentRole: "engineer",
    agentId,
    runId,
    taskType,
    stepTitle: `step ${id}`,
    status: "completed",
    toolCalls: ["memory:read", "GitHub"],
    toolCallCount: 2,
    critiqueVerdict: "pass",
    improvement: null,
    evalScore: 0.9,
    costCents: 3,
    latencyMs: 120,
    humanCorrected: false,
    skillApplied: false,
    createdAt,
  });
  await store.appendTrace(trace("tr_1", "engineer", "ship-feature", "run_a", t0));
  await store.appendTrace(trace("tr_2", "engineer", "ship-feature", "run_a", t1));
  await store.appendTrace(trace("tr_3", "engineer", "triage-bug", "run_b", t1));
  await store.appendTrace(trace("tr_4", "eng-ai-engineer", "ship-feature", "run_c", t1));

  await store.createDraft({
    id: "draft_1",
    companyId,
    agentId: "engineer",
    taskType: "ship-feature",
    kind: "skill",
    status: "quarantine",
    content: "# skill v1",
    contentHash: "h1",
    triggers: ["tool_call_threshold"],
    createdAt: t0,
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
  });
  await store.createDraft({
    id: "draft_2",
    companyId,
    agentId: "engineer",
    taskType: "triage-bug",
    kind: "skill",
    status: "quarantine",
    content: "# skill v2",
    contentHash: "h2",
    triggers: [],
    createdAt: t1,
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
  });
  await store.updateDraft("draft_1", { status: "live", promotedAt: t1, content: "# skill v1 live" });

  await store.appendIteration({
    id: "iter_1",
    companyId,
    agentId: "engineer",
    taskType: "ship-feature",
    candidateId: "draft_1",
    candidateKind: "skill",
    score: 0.8,
    delta: 0.1,
    decision: "pending_approval",
    triggers: ["tool_call_threshold"],
    blockedBy: null,
    inputHash: "abc",
    verdicts: { fixtures: [{ id: "f1", score: 1 }] },
    createdAt: t0,
  });
  await store.appendIteration({
    id: "iter_2",
    companyId,
    agentId: "engineer",
    taskType: "triage-bug",
    candidateId: null,
    candidateKind: null,
    score: null,
    delta: null,
    decision: "no_candidate",
    triggers: [],
    blockedBy: null,
    inputHash: null,
    verdicts: null,
    createdAt: t1,
  });

  await store.putFrontier({ companyId, agentId: "engineer", frontier: { roleId: "engineer", best: null, candidates: [] }, updatedAt: t0 });
  await store.putFrontier({ companyId, agentId: "engineer", frontier: { roleId: "engineer", best: { id: "c1" }, candidates: [{ id: "c1" }] }, updatedAt: t1 });

  await store.appendLedger({
    id: "led_1",
    companyId,
    agentId: "engineer",
    taskType: "ship-feature",
    action: "promote",
    artifactKind: "skill",
    artifactId: "draft_1",
    beforeHash: "h1",
    afterHash: "h1b",
    before: "# skill v1",
    after: "# skill v1 live",
    iterationId: "iter_1",
    actor: "human",
    createdAt: t1,
  });

  await store.putGateCache({ companyId, key: "baseline:s:v1:h1", value: { score: 0.5, failureClusters: {} }, createdAt: t0 });
  await store.putGateCache({ companyId, key: "baseline:s:v1:h1", value: { score: 0.75, failureClusters: { rubric_failed: 1 } }, createdAt: t1 });
  await store.putGateCache({ companyId: "co_other", key: "baseline:s:v1:h1", value: { score: 1 }, createdAt: t1 });

  const draft = await store.getDraft("draft_1");
  const iter = await store.getIteration("iter_1");
  const frontier = await store.getFrontier(companyId, "engineer");
  const ledger = await store.listLedger(companyId, { iterationId: "iter_1" });

  return {
    tracesForAgent: (await store.listTraces(companyId, { agentId: "engineer" })).length,
    tracesForOtherAgent: (await store.listTraces(companyId, { agentId: "eng-ai-engineer" })).length,
    tracesForTaskType: (await store.listTraces(companyId, { agentId: "engineer", taskType: "ship-feature" })).length,
    tracesByRun: (await store.tracesByRun("run_a")).length,
    countsByAgent: await store.countTracesByAgent(companyId),
    draftAfterUpdate: draft ? { status: draft.status, promotedAt: draft.promotedAt, content: draft.content } : null,
    quarantineDrafts: (await store.listDrafts(companyId, { status: "quarantine" })).length,
    iterationsNewestFirst: (await store.listIterations(companyId)).map((row) => row.id),
    iterationByIdDecision: iter?.decision ?? null,
    frontierRoundTrip: frontier?.frontier ?? null,
    frontierMissing: (await store.getFrontier(companyId, "nobody")) === null,
    ledgerForIteration: ledger.length,
    ledgerBeforeBytes: ledger[0]?.before ?? null,
    gateCacheRoundTrip: (await store.getGateCache(companyId, "baseline:s:v1:h1"))?.value ?? null,
    gateCacheOtherCompany: (await store.getGateCache("co_other", "baseline:s:v1:h1"))?.value ?? null,
    gateCacheMissing: (await store.getGateCache(companyId, "baseline:s:v1:nope")) === null,
  };
}

/** The expectations both runtimes must meet. Kept beside the scenario so they cannot drift. */
export function expectedStoreContract(): StoreContractResult {
  return {
    tracesForAgent: 3,
    tracesForOtherAgent: 1,
    tracesForTaskType: 2,
    tracesByRun: 2,
    countsByAgent: { engineer: 3, "eng-ai-engineer": 1 },
    draftAfterUpdate: { status: "live", promotedAt: "2026-09-12T10:00:01.000Z", content: "# skill v1 live" },
    quarantineDrafts: 1,
    iterationsNewestFirst: ["iter_2", "iter_1"],
    iterationByIdDecision: "pending_approval",
    frontierRoundTrip: { roleId: "engineer", best: { id: "c1" }, candidates: [{ id: "c1" }] },
    frontierMissing: true,
    ledgerForIteration: 1,
    ledgerBeforeBytes: "# skill v1",
    gateCacheRoundTrip: { score: 0.75, failureClusters: { rubric_failed: 1 } },
    gateCacheOtherCompany: { score: 1 },
    gateCacheMissing: true,
  };
}
