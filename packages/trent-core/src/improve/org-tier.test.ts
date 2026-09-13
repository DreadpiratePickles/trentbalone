/**
 * Item 7 — a promoted org-tier skill is re-gated against EVERY consuming agent's suite before it
 * reaches them. Consumers whose suite the skill fails never receive it.
 */
import { describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "./memory-store.js";
import { contentHash, promoteOrgSkill, readLiveSkills, resolveSweepScope, type GateVerdict } from "./index.js";

const COMPANY = "co_org";

describe("promoteOrgSkill", () => {
  it("re-gates per consumer and only the passing consumers get a live copy", async () => {
    const store = new InMemoryImproveStore();
    await store.createDraft({
      id: "org_1",
      companyId: COMPANY,
      agentId: "__org__",
      taskType: "weekly-update",
      kind: "skill",
      status: "quarantine",
      content: "# weekly update",
      contentHash: contentHash("# weekly update"),
      triggers: ["human_correction"],
      createdAt: "t",
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    });
    const gated: string[] = [];
    const result = await promoteOrgSkill(store, {
      draftId: "org_1",
      consumers: ["ceo", "finance", "eng-ai-engineer"],
      actor: "human",
      gateFor: async (agentId): Promise<GateVerdict> => {
        gated.push(agentId);
        return agentId === "finance"
          ? { promoted: false, score: 0.3, delta: -0.4, blockedBy: "regression", stage: "deterministic", judgeCalls: 0, fixtures: [], failureClusters: { missing_expected_text: 1 }, costCents: 0 }
          : { promoted: true, score: 1, delta: 0, stage: "judge", judgeCalls: 0, fixtures: [], failureClusters: {}, costCents: 0 };
      },
    });
    expect(gated).toEqual(["ceo", "finance", "eng-ai-engineer"]);
    expect(result.reached).toEqual(["ceo", "eng-ai-engineer"]);
    expect(result.blocked).toEqual([{ agentId: "finance", blockedBy: "regression" }]);
    expect(await readLiveSkills(store, COMPANY, "ceo")).toEqual([{ taskType: "weekly-update", content: "# weekly update" }]);
    expect(await readLiveSkills(store, COMPANY, "finance")).toEqual([]);
    expect((await store.listIterations(COMPANY, { agentId: "finance" }))[0]?.decision).toBe("rejected");
    expect((await store.listLedger(COMPANY, { agentId: "ceo" })).map((l) => l.action)).toEqual(["promote"]);
  });

  it("refuses a non-human actor", async () => {
    const store = new InMemoryImproveStore();
    await expect(
      promoteOrgSkill(store, { draftId: "x", consumers: [], actor: "agent", gateFor: async (): Promise<GateVerdict> => ({ promoted: true, score: 1, delta: 0, stage: "judge", judgeCalls: 0, fixtures: [], failureClusters: {}, costCents: 0 }) }),
    ).rejects.toThrow(/human/);
  });
});

describe("resolveSweepScope", () => {
  it("nine seats always; specialists only while installed and at or above the threshold", () => {
    const scope = resolveSweepScope({
      installedAgents: ["eng-ai-engineer", "spec-thin", "ceo"],
      traceCounts: { engineer: 0, "eng-ai-engineer": 5, "spec-thin": 2, "spec-ghost": 40 },
      threshold: 3,
    });
    expect(scope.agents).toEqual(["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "browser", "escalation", "eng-ai-engineer"]);
    expect(scope.skipped).toEqual([{ agentId: "spec-thin", reason: "below_threshold", traces: 2, threshold: 3 }]);
  });
});
