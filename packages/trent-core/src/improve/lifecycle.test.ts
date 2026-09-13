/**
 * Item 5 — adopted from Hermes: retirement, ledger, rollback.
 */
import { describe, expect, it } from "vitest";

import type { SkillDraftRow } from "../store/StorePort.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { SweepMeter, contentHash, createMemoryExemplarStore, improveStatus, promoteDraft, recoverDraft, rejectDraft, retireSkills, rollback } from "./index.js";

const COMPANY = "co_life";
const T = (day: number) => `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`;

function draft(over: Partial<SkillDraftRow> & { id: string }): SkillDraftRow {
  return {
    companyId: COMPANY,
    agentId: "engineer",
    taskType: over.id,
    kind: "skill",
    status: "quarantine",
    content: `# ${over.id}`,
    contentHash: contentHash(`# ${over.id}`),
    triggers: [],
    createdAt: T(1),
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
    ...over,
  };
}

describe("retirement", () => {
  it("stale after N days unused and NOT listed; archived after M; listed skills are never retired", async () => {
    const store = new InMemoryImproveStore();
    await store.createDraft(draft({ id: "fresh", status: "live", promotedAt: T(1), lastUsedAt: T(20) }));
    await store.createDraft(draft({ id: "stale-ish", status: "live", promotedAt: T(1), lastUsedAt: T(5) }));
    await store.createDraft(draft({ id: "ancient", status: "live", promotedAt: T(1), lastUsedAt: null }));
    await store.createDraft(draft({ id: "listed", status: "live", promotedAt: T(1), lastUsedAt: null }));

    const report = await retireSkills(store, COMPANY, {
      now: T(21),
      staleAfterDays: 14,
      archiveAfterDays: 20,
      listed: new Set(["listed"]),
    });
    expect(report).toEqual({ stale: ["stale-ish"], archived: ["ancient"], kept: ["fresh", "listed"] });
    expect((await store.getDraft("stale-ish"))?.status).toBe("stale");
    expect((await store.getDraft("ancient"))?.status).toBe("archived");
    expect((await store.getDraft("ancient"))?.retiredAt).toBe(T(21));
    expect((await store.getDraft("listed"))?.status).toBe("live");

    // Both are recoverable, and every archive wrote a ledger row.
    await recoverDraft(store, "ancient", "human", T(22));
    expect((await store.getDraft("ancient"))?.status).toBe("live");
    const ledger = await store.listLedger(COMPANY, { artifactId: "ancient" });
    expect(ledger.map((l) => l.action)).toEqual(["archive", "recover"]);
  });
});

describe("ledger", () => {
  it("every promote writes a before/after hash row; a fix on a live skill writes a 'fix' row with the prior bytes", async () => {
    const store = new InMemoryImproveStore();
    await store.createDraft(draft({ id: "d1", taskType: "ship" }));
    await promoteDraft(store, "d1", { actor: "human" });
    const [promote] = await store.listLedger(COMPANY, { artifactId: "d1" });
    expect(promote?.action).toBe("promote");
    expect(promote?.beforeHash).toBeNull();
    expect(promote?.afterHash).toBe(contentHash("# d1"));
    expect(promote?.after).toBe("# d1");

    await store.createDraft(draft({ id: "d2", taskType: "ship", content: "# d1 fixed", contentHash: contentHash("# d1 fixed") }));
    await promoteDraft(store, "d2", { actor: "human" });
    const rows = await store.listLedger(COMPANY, { artifactId: "d2" });
    expect(rows.map((r) => r.action)).toEqual(["fix"]);
    expect(rows[0]?.beforeHash).toBe(contentHash("# d1"));
    expect(rows[0]?.before).toBe("# d1");
    expect(rows[0]?.afterHash).toBe(contentHash("# d1 fixed"));
    // The previous live skill for that task type is superseded, never silently deleted.
    expect((await store.getDraft("d1"))?.status).toBe("archived");
    expect((await store.getDraft("d2"))?.status).toBe("live");
  });
});

describe("rollback", () => {
  it("rollback <iterationId> restores the prior artifact byte-for-byte and writes a rollback row", async () => {
    const store = new InMemoryImproveStore();
    const original = "# ship v1\n\nexact bytes é \t here\n";
    await store.createDraft(draft({ id: "v1", taskType: "ship", content: original, contentHash: contentHash(original) }));
    await promoteDraft(store, "v1", { actor: "human" });
    await store.createDraft(draft({ id: "v2", taskType: "ship", content: "# ship v2", contentHash: contentHash("# ship v2") }));
    await store.appendIteration({
      id: "iter_fix",
      companyId: COMPANY,
      agentId: "engineer",
      taskType: "ship",
      candidateId: "v2",
      candidateKind: "skill",
      score: 0.9,
      delta: 0.1,
      decision: "pending_approval",
      triggers: ["skill_health"],
      blockedBy: null,
      inputHash: "x",
      verdicts: null,
      createdAt: T(2),
    });
    await promoteDraft(store, "v2", { actor: "human", iterationId: "iter_fix" });
    expect((await store.getDraft("v1"))?.status).toBe("archived");

    const result = await rollback(store, "iter_fix", "human");
    expect(result.restored).toEqual([{ artifactId: "v1", taskType: "ship" }]);
    expect((await store.getDraft("v1"))?.status).toBe("live");
    expect((await store.getDraft("v1"))?.content).toBe(original);
    expect((await store.getDraft("v2"))?.status).toBe("rejected");
    const ledger = await store.listLedger(COMPANY, { iterationId: "iter_fix" });
    expect(ledger.map((l) => l.action)).toEqual(["fix", "rollback"]);
    expect(ledger[1]?.after).toBe(original);
    expect(ledger[1]?.afterHash).toBe(contentHash(original));
  });

  it("refuses an unknown iteration", async () => {
    const store = new InMemoryImproveStore();
    await expect(rollback(store, "nope", "human")).rejects.toThrow(/iteration nope/);
  });
});

describe("judge-versus-human agreement ledger (I.8)", () => {
  async function gated(store: InMemoryImproveStore, id: string, promoted: boolean): Promise<void> {
    await store.createDraft(draft({ id, taskType: id }));
    await store.appendIteration({
      id: `iter_${id}`,
      companyId: COMPANY,
      agentId: "engineer",
      taskType: id,
      candidateId: id,
      candidateKind: "skill",
      score: 0.9,
      delta: promoted ? 0.1 : -0.1,
      decision: promoted ? "pending_approval" : "rejected",
      triggers: [],
      blockedBy: promoted ? null : "regression",
      inputHash: "x",
      verdicts: { promoted, score: 0.9 },
      createdAt: T(2),
    });
  }

  it("a human reject after a judge pass writes judgeAgreement: false; a promote after a judge pass writes true", async () => {
    const store = new InMemoryImproveStore();
    await gated(store, "judge-passed-rejected", true);
    await rejectDraft(store, "judge-passed-rejected", "human", T(3));
    const [reject] = await store.listLedger(COMPANY, { artifactId: "judge-passed-rejected" });
    expect(reject?.action).toBe("reject");
    expect(reject?.judgeAgreement).toBe(false);

    await gated(store, "judge-passed-promoted", true);
    await promoteDraft(store, "judge-passed-promoted", { actor: "human", now: T(3) });
    const [promote] = await store.listLedger(COMPANY, { artifactId: "judge-passed-promoted" });
    expect(promote?.judgeAgreement).toBe(true);

    // A human promote over a judge REJECT is a disagreement too; a draft nobody gated records null.
    await gated(store, "judge-failed-promoted", false);
    await promoteDraft(store, "judge-failed-promoted", { actor: "human", now: T(3) });
    expect((await store.listLedger(COMPANY, { artifactId: "judge-failed-promoted" }))[0]?.judgeAgreement).toBe(false);
    await store.createDraft(draft({ id: "ungated" }));
    await rejectDraft(store, "ungated", "human", T(3));
    expect((await store.listLedger(COMPANY, { artifactId: "ungated" }))[0]?.judgeAgreement).toBeNull();

    const status = await improveStatus(store, COMPANY);
    expect(status.judgeAgreement).toEqual({ agreed: 1, disagreed: 2, rate: 0.33 });
  });
});

describe("promotion distils a clean exemplar and rationalises it (I.13, I.14)", () => {
  it("promoteDraft writes one golden per clean run, successful steps only, pointing at the run, with one metered rationale call", async () => {
    const store = new InMemoryImproveStore();
    const row = (id: string, runId: string, status: string, verdict: string | null, at: string) =>
      store.appendTrace({
        id,
        companyId: COMPANY,
        agentRole: "engineer",
        agentId: "engineer",
        runId,
        taskType: "ship-feature",
        stepTitle: `step ${id}`,
        status,
        toolCalls: ["GitHub"],
        toolCallCount: 1,
        critiqueVerdict: verdict,
        improvement: null,
        evalScore: null,
        costCents: 1,
        latencyMs: null,
        humanCorrected: false,
        skillApplied: false,
        createdAt: at,
      });
    await row("a1", "run_clean", "completed", "pass", T(1));
    await row("a2", "run_clean", "completed", "retry", T(2));
    await row("a3", "run_clean", "completed", "pass", T(3));
    await row("b1", "run_blocked", "blocked", null, T(1));
    await row("b2", "run_blocked", "completed", "pass", T(2));
    await store.createDraft(draft({ id: "d_exemplar", taskType: "ship-feature" }));

    const exemplars = createMemoryExemplarStore();
    const meter = new SweepMeter(undefined);
    let asked = 0;
    await promoteDraft(store, "d_exemplar", {
      actor: "human",
      now: T(5),
      distill: {
        exemplars,
        meter,
        rationalise: async () => {
          asked += 1;
          return { text: '{"steps":[{"index":1,"why":"first"},{"index":2,"why":"then"}]}', costCents: 1 };
        },
      },
    });
    const goldens = await exemplars.list();
    expect(goldens.map((g) => g.distilledFrom)).toEqual(["run_clean"]);
    expect(goldens[0]?.steps.map((s) => s.title)).toEqual(["step a1", "step a3"]);
    expect(goldens[0]?.candidateId).toBe("d_exemplar");
    expect(goldens[0]?.rationale).toEqual(["first", "then"]);
    expect(asked).toBe(1);
    expect(meter.phases.rationalise.calls).toBe(1);
  });
});
