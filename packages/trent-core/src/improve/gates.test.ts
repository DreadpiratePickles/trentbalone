/**
 * [D0] gates 1, 5 and 6 through the sweep and the gate: the frozen surface, the content-hash veto
 * and judge calibration as rates.
 *
 * Reflection stays OFF here (`skipLLM: true`): these are the gates that must exist BEFORE any
 * model is allowed to rewrite the loop's own artifacts.
 */
import { describe, expect, it } from "vitest";

import type { AgentTraceRow, ImproveStorePort, SkillLedgerRow } from "../store/StorePort.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";
import { BUNDLED_SKILLS_DIR } from "../fleet/SkillProvisioner.js";
import { createFrozenSurface } from "./frozen-surface.js";
import { executeGate } from "./gate.js";
import { DEFAULT_JUDGE_MIN_TNR, DEFAULT_JUDGE_MIN_TPR, isJudgeAdvisory, judgeCalibration } from "./calibration.js";
import { contentHash } from "./ledger.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { promoteDraft, rejectDraft } from "./lifecycle.js";
import { runImprovementSweep } from "./sweep.js";
import { vetoedHashes } from "./veto.js";

const COMPANY = "co_d0";

function trace(store: ImproveStorePort, over: Partial<AgentTraceRow> & { id: string }): Promise<void> {
  return store.appendTrace({
    companyId: COMPANY,
    agentRole: "engineer",
    agentId: "engineer",
    runId: "run_1",
    taskType: "ship-feature",
    stepTitle: "implement",
    status: "completed",
    toolCalls: ["GitHub", "memory:read", "GitHub"],
    toolCallCount: 3,
    critiqueVerdict: "pass",
    improvement: null,
    evalScore: 0.9,
    costCents: 4,
    latencyMs: 100,
    humanCorrected: false,
    skillApplied: false,
    createdAt: "2026-09-18T10:00:00.000Z",
    ...over,
  });
}

async function seed(store: ImproveStorePort): Promise<void> {
  await trace(store, { id: "t1" });
  await trace(store, { id: "t2", critiqueVerdict: "retry", improvement: "cite the diff" });
  await trace(store, { id: "t3" });
}

const SWEEP_AT = "2026-09-18T11:00:00.000Z";
const SUITE = { id: "s", version: "v1", fixtures: [{ id: "s:1", prompt: "say ok", graders: [{ type: "contains" as const, weight: 1, values: ["ok"] }] }] };

describe("[D0] gate 1 — the sweep refuses a draft that would touch a frozen path", () => {
  it("rejects the distilled draft, ledgers the refusal, and never calls the model", async () => {
    const store = new InMemoryImproveStore();
    await seed(store);
    const report = await runImprovementSweep(COMPANY, {
      store,
      installedAgents: [],
      agentFilter: "engineer",
      skipLLM: true,
      passK: 1,
      // The loop is pointed at the bundled suites: every skill it writes would land inside them.
      frozenSurface: createFrozenSurface({ profileDir: "/tmp/trent-d0", blocks: DEFAULT_MEMORY_BLOCKS, skillWriteRoot: BUNDLED_SKILLS_DIR }),
      suiteFor: () => SUITE,
      seatPrompt: async () => "SEAT",
      actuals: async () => {
        throw new Error("a frozen draft must be refused before it is scored");
      },
    });
    expect(report.errors).toEqual([]);
    const iterations = await store.listIterations(COMPANY, { agentId: "engineer" });
    const gated = iterations.find((i) => i.candidateId !== null)!;
    expect(gated.blockedBy).toBe("frozen_surface");
    expect(JSON.stringify(gated.verdicts)).toContain(BUNDLED_SKILLS_DIR);
    expect((await store.getDraft(gated.candidateId!))?.status).toBe("rejected");
    const ledger = await store.listLedger(COMPANY, { artifactId: gated.candidateId! });
    expect(ledger.map((l) => `${l.action}:${l.actor}`)).toEqual(["reject:gate:frozen_surface"]);
  });
});

describe("[D0] gate 5 — content-hash veto", () => {
  it("a hash that was rejected before is refused again, before any scoring", async () => {
    // What the foundry distils from this trace set, measured on a probe store.
    const probe = new InMemoryImproveStore();
    await seed(probe);
    await runImprovementSweep(COMPANY, { store: probe, installedAgents: [], agentFilter: "engineer", skipLLM: true, now: () => SWEEP_AT });
    const content = (await probe.listDrafts(COMPANY, { status: "quarantine" }))[0]!.content;

    const store = new InMemoryImproveStore();
    await seed(store);
    await store.createDraft({
      id: "skill_old",
      companyId: COMPANY,
      agentId: "engineer",
      taskType: "ship-feature",
      kind: "skill",
      status: "quarantine",
      content,
      contentHash: contentHash(content),
      triggers: [],
      createdAt: "2026-09-18T09:00:00.000Z",
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    });
    await rejectDraft(store, "skill_old", "human", "2026-09-18T09:30:00.000Z");
    expect(await vetoedHashes(store, COMPANY)).toContain(contentHash(content));

    const executed: string[] = [];
    const report = await runImprovementSweep(COMPANY, {
      store,
      installedAgents: [],
      agentFilter: "engineer",
      skipLLM: true,
      passK: 1,
      suiteFor: () => SUITE,
      seatPrompt: async () => "SEAT",
      now: () => SWEEP_AT,
      // Every prompt the gate would execute is captured: the vetoed bytes must never reach one.
      actuals: async ({ systemPrompt }) => {
        executed.push(systemPrompt);
        return { text: "ok", toolCalls: [], costCents: 0 };
      },
    });
    expect(report.errors).toEqual([]);
    expect(executed.some((prompt) => prompt.includes(content))).toBe(false);
    const gated = (await store.listIterations(COMPANY, { agentId: "engineer" })).find((i) => i.candidateId !== null && i.candidateId !== "skill_old")!;
    expect(gated.blockedBy).toBe("content_vetoed");
    expect((await store.getDraft(gated.candidateId!))?.status).toBe("rejected");
  });
});

describe("[D0] gate 1 — the promotion door is frozen too", () => {
  it("refuses to promote a draft whose write would land on a frozen path, names it, and ledgers the refusal", async () => {
    const store = new InMemoryImproveStore();
    const content = JSON.stringify({ profileDir: "/tmp/trent-d0", memory: "a line", user: "another", dropped: [] });
    await store.createDraft({
      id: "memory_1",
      companyId: COMPANY,
      agentId: "__fleet__",
      taskType: "memory_consolidation",
      kind: "memory",
      status: "quarantine",
      content,
      contentHash: contentHash(content),
      triggers: [],
      createdAt: SWEEP_AT,
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    });
    const frozen = createFrozenSurface({ profileDir: "/tmp/trent-d0", blocks: DEFAULT_MEMORY_BLOCKS });
    await expect(promoteDraft(store, "memory_1", { actor: "human", frozen, now: SWEEP_AT })).rejects.toThrow(/block:memory/);
    expect((await store.getDraft("memory_1"))?.status).toBe("quarantine");
    const ledger = await store.listLedger(COMPANY, { artifactId: "memory_1" });
    expect(ledger.map((l) => `${l.action}:${l.actor}`)).toEqual(["reject:gate:frozen_surface"]);
  });
});

function ledgerRow(over: Partial<SkillLedgerRow>): SkillLedgerRow {
  return {
    id: `ledger_${Math.random().toString(16).slice(2)}`,
    companyId: COMPANY,
    agentId: "engineer",
    taskType: "ship-feature",
    action: "promote",
    artifactKind: "skill",
    artifactId: "skill_1",
    beforeHash: null,
    afterHash: null,
    before: null,
    after: null,
    iterationId: "iter_1",
    actor: "human",
    judgeAgreement: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    ...over,
  };
}

describe("[D0] gate 6 — judge calibration as rates, not raw agreement", () => {
  const lenient = [
    ...Array.from({ length: 9 }, () => ledgerRow({ action: "promote", judgeAgreement: true })),
    ledgerRow({ action: "reject", judgeAgreement: false }),
  ];

  it("reports true positive and true negative rates with their counts", () => {
    const calibration = judgeCalibration(lenient);
    expect(calibration.truePositives).toBe(9);
    expect(calibration.falseNegatives).toBe(0);
    expect(calibration.falsePositives).toBe(1);
    expect(calibration.trueNegatives).toBe(0);
    expect(calibration.tpr).toBe(1);
    expect(calibration.tnr).toBe(0);
    // Raw agreement alone would call this judge excellent.
    expect(calibration.rate).toBe(0.9);
    expect(DEFAULT_JUDGE_MIN_TPR).toBe(0.8);
    expect(DEFAULT_JUDGE_MIN_TNR).toBe(0.8);
    expect(isJudgeAdvisory(calibration)).toBe(true);
  });

  it("a rate with no decisions on that side is not a floor breach", () => {
    const calibration = judgeCalibration([ledgerRow({ action: "promote", judgeAgreement: true })]);
    expect(calibration.tnr).toBeNull();
    expect(isJudgeAdvisory(calibration)).toBe(false);
  });

  it("a judge below the floor is advisory: its pass cannot make a rubric fixture pass", async () => {
    const rubricSuite = { id: "r", version: "v1", fixtures: [{ id: "r:1", prompt: "one", graders: [{ type: "llm_rubric" as const, weight: 1, rubric: "Is right." }] }] };
    const verdict = await executeGate({
      candidate: { id: "c", kind: "prompt", content: "P" },
      seatPrompt: "seat",
      suite: rubricSuite,
      baseline: { score: 0, failureClusters: {}, fixtures: [{ id: "r:1", passed: false, score: 0 }] },
      judgeAdvisory: isJudgeAdvisory(judgeCalibration(lenient)),
      passK: 1,
      actuals: async () => ({ text: "anything at all", toolCalls: [], costCents: 0 }),
      judge: async () => ({ pass: true, evidence: "anything at all" }),
    });
    expect(verdict.fixtures[0]?.passed).toBe(false);
    expect(verdict.pendingRubrics).toBe(1);
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("unverified");
  });
});
