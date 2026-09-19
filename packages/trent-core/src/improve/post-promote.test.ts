/**
 * [D0] gate 4 — the post-promotion regression trigger.
 *
 * Rollback existed and nothing ever called it (design review section 6, item 3). After a human
 * promotion the holdout is re-run under the sweep cap against the artifact that is now live; a
 * score below the pre-promotion holdout score rolls the promotion back through the existing
 * `rollback` path, so the previous artifact is live again byte-for-byte and the ledger says who
 * decided.
 */
import { describe, expect, it } from "vitest";

import type { ImproveStorePort, IterationRow, SkillDraftRow } from "../store/StorePort.js";
import { promoteDraft } from "./lifecycle.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { HOLDOUT_ROLLBACK_ACTOR, verifyPromotion } from "./post-promote.js";
import type { FrozenSuite } from "./suites.js";

const COMPANY = "co_pp";
const PRIOR = "## live skill\nthe bytes that were live";
const NEXT = "## candidate skill\nthe bytes a human promoted";

const SUITE: FrozenSuite = {
  id: "s",
  version: "v1",
  fixtures: [
    { id: "s:opt", prompt: "optimise", graders: [{ type: "contains", weight: 1, values: ["ok"] }], holdout: false },
    { id: "s:hold", prompt: "holdout", graders: [{ type: "contains", weight: 1, values: ["ok"] }], holdout: true },
  ],
};

function draft(over: Partial<SkillDraftRow> & { id: string; content: string; status: SkillDraftRow["status"] }): SkillDraftRow {
  return {
    companyId: COMPANY,
    agentId: "engineer",
    taskType: "ship-feature",
    kind: "skill",
    contentHash: "",
    triggers: [],
    createdAt: "2026-09-18T09:00:00.000Z",
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
    ...over,
  } as SkillDraftRow;
}

function iteration(candidateId: string, holdoutScore: number): IterationRow {
  return {
    id: "iter_1",
    companyId: COMPANY,
    agentId: "engineer",
    taskType: "ship-feature",
    candidateId,
    candidateKind: "skill",
    score: 1,
    delta: 0.5,
    decision: "pending_approval",
    triggers: [],
    blockedBy: null,
    inputHash: "h",
    verdicts: { promoted: true, holdout: { score: holdoutScore, delta: 0, fixtures: 1, regressions: [] } },
    createdAt: "2026-09-18T09:30:00.000Z",
  };
}

async function promoted(store: ImproveStorePort, holdoutScore = 1): Promise<void> {
  await store.createDraft(draft({ id: "skill_prior", content: PRIOR, status: "live", promotedAt: "2026-09-17T09:00:00.000Z" }));
  await store.createDraft(draft({ id: "skill_next", content: NEXT, status: "quarantine" }));
  await store.appendIteration(iteration("skill_next", holdoutScore));
  await promoteDraft(store, "skill_next", { actor: "human", now: "2026-09-18T10:00:00.000Z" });
}

describe("[D0] post-promotion holdout re-run", () => {
  it("a regressing holdout rolls the promotion back and leaves the previous artifact live", async () => {
    const store = new InMemoryImproveStore();
    await promoted(store);
    const report = await verifyPromotion({
      store,
      draftId: "skill_next",
      suite: SUITE,
      seatPrompt: "SEAT",
      passK: 1,
      budgetCents: 100,
      now: "2026-09-18T10:05:00.000Z",
      // The promoted skill is in the prompt and the holdout fixture now fails.
      actuals: async ({ systemPrompt }) => ({ text: systemPrompt.includes(NEXT) ? "not what we wanted" : "ok", toolCalls: [], costCents: 1 }),
    });

    expect(report.previousScore).toBe(1);
    expect(report.score).toBe(0);
    expect(report.regressed).toBe(true);
    expect(report.rolledBack?.iterationId).toBe("iter_1");

    const live = await store.listDrafts(COMPANY, { agentId: "engineer", taskType: "ship-feature", kind: "skill", status: "live" });
    expect(live.map((d) => d.content)).toEqual([PRIOR]);
    expect((await store.getDraft("skill_next"))?.status).toBe("rejected");
    const ledger = await store.listLedger(COMPANY);
    const rolled = ledger.filter((l) => l.action === "rollback");
    expect(rolled.length).toBe(1);
    expect(rolled[0]?.actor).toBe(HOLDOUT_ROLLBACK_ACTOR);
  });

  it("only the holdout partition is re-run, and a holdout that holds leaves the promotion standing", async () => {
    const store = new InMemoryImproveStore();
    await promoted(store);
    const seen: string[] = [];
    const report = await verifyPromotion({
      store,
      draftId: "skill_next",
      suite: SUITE,
      seatPrompt: "SEAT",
      passK: 1,
      budgetCents: 100,
      actuals: async ({ fixtureId }) => {
        seen.push(fixtureId);
        return { text: "ok", toolCalls: [], costCents: 1 };
      },
    });
    expect(seen).toEqual(["s:hold"]);
    expect(report.regressed).toBe(false);
    expect(report.rolledBack).toBeNull();
    expect((await store.getDraft("skill_next"))?.status).toBe("live");
  });

  it("a holdout that cannot be measured under the cap never rolls anything back", async () => {
    const store = new InMemoryImproveStore();
    await promoted(store);
    const report = await verifyPromotion({
      store,
      draftId: "skill_next",
      suite: SUITE,
      seatPrompt: "SEAT",
      passK: 1,
      budgetCents: 0,
      actuals: async () => ({ text: "nope", toolCalls: [], costCents: 5 }),
    });
    expect(report.blockedBy).toBe("budget_exhausted");
    expect(report.regressed).toBe(false);
    expect(report.rolledBack).toBeNull();
    expect((await store.getDraft("skill_next"))?.status).toBe("live");
  });

  it("without a pre-promotion holdout score there is nothing to regress against", async () => {
    const store = new InMemoryImproveStore();
    await store.createDraft(draft({ id: "skill_solo", content: NEXT, status: "quarantine" }));
    await promoteDraft(store, "skill_solo", { actor: "human", now: "2026-09-18T10:00:00.000Z" });
    const report = await verifyPromotion({
      store,
      draftId: "skill_solo",
      suite: SUITE,
      seatPrompt: "SEAT",
      passK: 1,
      actuals: async () => ({ text: "nope", toolCalls: [], costCents: 0 }),
    });
    expect(report.blockedBy).toBe("no_baseline");
    expect(report.rolledBack).toBeNull();
    expect((await store.getDraft("skill_solo"))?.status).toBe("live");
  });
});
