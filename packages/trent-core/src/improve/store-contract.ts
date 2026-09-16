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
  /** I.15: a trace's failure tags round-trip, and a row written without any reads as empty. */
  traceFailureTags: string[];
  traceFailureTagsMissing: string[];
  countsByAgent: Record<string, number>;
  draftAfterUpdate: { status: string; promotedAt: string | null; content: string } | null;
  quarantineDrafts: number;
  iterationsNewestFirst: string[];
  iterationByIdDecision: string | null;
  frontierRoundTrip: unknown;
  frontierMissing: boolean;
  ledgerForIteration: number;
  ledgerBeforeBytes: string | null;
  /** I.8: the judge-agreement flag round-trips as a boolean and a missing one reads as null. */
  ledgerJudgeAgreement: boolean | null;
  ledgerJudgeAgreementMissing: boolean | null;
  /** I.3: the gate cache round-trips JSON, overwrites on the same key, and misses cleanly. */
  gateCacheRoundTrip: unknown;
  gateCacheOtherCompany: unknown;
  gateCacheMissing: boolean;
  /** T4.1: agent versions round-trip their JSON columns, list highest version first, patch labels only, and miss cleanly. */
  agentVersionsNewestFirst: Array<[version: number, label: string]>;
  agentVersionLive: { id: string; prompt: string; skills: number; toolsets: string[]; model: { provider: string; model: string } } | null;
  agentVersionOtherAgent: number;
  agentVersionMissing: boolean;
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
  await store.appendTrace({ ...trace("tr_1", "engineer", "ship-feature", "run_a", t0), failureTags: ["repetitive_loop:GitHub"] });
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
    judgeAgreement: false,
    createdAt: t1,
  });
  await store.appendLedger({
    id: "led_2",
    companyId,
    agentId: "engineer",
    taskType: "ship-feature",
    action: "retire",
    artifactKind: "skill",
    artifactId: "draft_1",
    beforeHash: "h1b",
    afterHash: "h1b",
    before: "# skill v1 live",
    after: "# skill v1 live",
    iterationId: null,
    actor: "curator",
    createdAt: t1,
  });

  await store.putGateCache({ companyId, key: "baseline:s:v1:h1", value: { score: 0.5, failureClusters: {} }, createdAt: t0 });
  await store.putGateCache({ companyId, key: "baseline:s:v1:h1", value: { score: 0.75, failureClusters: { rubric_failed: 1 } }, createdAt: t1 });
  await store.putGateCache({ companyId: "co_other", key: "baseline:s:v1:h1", value: { score: 1 }, createdAt: t1 });

  const version = (id: string, agentId: string, version: number, prompt: string, createdAt: string) => ({
    id,
    companyId,
    agentId,
    version,
    promptHash: `ph_${version}`,
    model: { provider: "anthropic", model: "claude-sonnet-4-5" },
    toolsets: ["file_ops", "terminal"],
    skillsHash: "sh_1",
    label: "candidate" as const,
    createdAt,
    iterationId: null,
    definition: { prompt, model: { provider: "anthropic", model: "claude-sonnet-4-5" }, toolsets: ["file_ops", "terminal"], skills: [{ slug: "repo-audit", content: "# Repository Audit" }] },
  });
  await store.createAgentVersion(version("av_1", "engineer", 1, "engineer v1", t0));
  await store.createAgentVersion(version("av_2", "engineer", 2, "engineer v2", t1));
  await store.createAgentVersion(version("av_3", "growth", 1, "growth v1", t1));
  await store.updateAgentVersion("av_1", { label: "archived" });
  await store.updateAgentVersion("av_2", { label: "live", iterationId: "iter_1" });

  const draft = await store.getDraft("draft_1");
  const iter = await store.getIteration("iter_1");
  const liveVersion = (await store.listAgentVersions(companyId, { agentId: "engineer", label: "live" }))[0];
  const frontier = await store.getFrontier(companyId, "engineer");
  const ledger = await store.listLedger(companyId, { iterationId: "iter_1" });

  return {
    tracesForAgent: (await store.listTraces(companyId, { agentId: "engineer" })).length,
    tracesForOtherAgent: (await store.listTraces(companyId, { agentId: "eng-ai-engineer" })).length,
    tracesForTaskType: (await store.listTraces(companyId, { agentId: "engineer", taskType: "ship-feature" })).length,
    tracesByRun: (await store.tracesByRun("run_a")).length,
    traceFailureTags: (await store.tracesByRun("run_a")).find((t) => t.id === "tr_1")?.failureTags ?? ["<absent>"],
    traceFailureTagsMissing: (await store.tracesByRun("run_a")).find((t) => t.id === "tr_2")?.failureTags ?? ["<absent>"],
    countsByAgent: await store.countTracesByAgent(companyId),
    draftAfterUpdate: draft ? { status: draft.status, promotedAt: draft.promotedAt, content: draft.content } : null,
    quarantineDrafts: (await store.listDrafts(companyId, { status: "quarantine" })).length,
    iterationsNewestFirst: (await store.listIterations(companyId)).map((row) => row.id),
    iterationByIdDecision: iter?.decision ?? null,
    frontierRoundTrip: frontier?.frontier ?? null,
    frontierMissing: (await store.getFrontier(companyId, "nobody")) === null,
    ledgerForIteration: ledger.length,
    ledgerBeforeBytes: ledger[0]?.before ?? null,
    ledgerJudgeAgreement: ledger[0]?.judgeAgreement ?? null,
    ledgerJudgeAgreementMissing: (await store.listLedger(companyId, { artifactId: "draft_1" })).find((row) => row.id === "led_2")?.judgeAgreement ?? null,
    gateCacheRoundTrip: (await store.getGateCache(companyId, "baseline:s:v1:h1"))?.value ?? null,
    gateCacheOtherCompany: (await store.getGateCache("co_other", "baseline:s:v1:h1"))?.value ?? null,
    gateCacheMissing: (await store.getGateCache(companyId, "baseline:s:v1:nope")) === null,
    agentVersionsNewestFirst: (await store.listAgentVersions(companyId, { agentId: "engineer" })).map((v) => [v.version, v.label]),
    agentVersionLive: liveVersion
      ? { id: liveVersion.id, prompt: liveVersion.definition.prompt, skills: liveVersion.definition.skills.length, toolsets: liveVersion.toolsets, model: liveVersion.model }
      : null,
    agentVersionOtherAgent: (await store.listAgentVersions(companyId, { agentId: "growth" })).length,
    agentVersionMissing: (await store.getAgentVersion("av_nope")) === null,
  };
}

/** The expectations both runtimes must meet. Kept beside the scenario so they cannot drift. */
export function expectedStoreContract(): StoreContractResult {
  return {
    tracesForAgent: 3,
    tracesForOtherAgent: 1,
    tracesForTaskType: 2,
    tracesByRun: 2,
    traceFailureTags: ["repetitive_loop:GitHub"],
    traceFailureTagsMissing: [],
    countsByAgent: { engineer: 3, "eng-ai-engineer": 1 },
    draftAfterUpdate: { status: "live", promotedAt: "2026-09-12T10:00:01.000Z", content: "# skill v1 live" },
    quarantineDrafts: 1,
    iterationsNewestFirst: ["iter_2", "iter_1"],
    iterationByIdDecision: "pending_approval",
    frontierRoundTrip: { roleId: "engineer", best: { id: "c1" }, candidates: [{ id: "c1" }] },
    frontierMissing: true,
    ledgerForIteration: 1,
    ledgerBeforeBytes: "# skill v1",
    ledgerJudgeAgreement: false,
    ledgerJudgeAgreementMissing: null,
    gateCacheRoundTrip: { score: 0.75, failureClusters: { rubric_failed: 1 } },
    gateCacheOtherCompany: { score: 1 },
    gateCacheMissing: true,
    agentVersionsNewestFirst: [
      [2, "live"],
      [1, "archived"],
    ],
    agentVersionLive: { id: "av_2", prompt: "engineer v2", skills: 1, toolsets: ["file_ops", "terminal"], model: { provider: "anthropic", model: "claude-sonnet-4-5" } },
    agentVersionOtherAgent: 1,
    agentVersionMissing: true,
  };
}
