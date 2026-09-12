import { describe, expect, it } from "vitest";
import { persistCeoDecisionJournal } from "@/lib/ceo-decision-journal";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationRun } from "@/lib/orchestrator";

describe("CEO decision journal", () => {
  it("writes a semantic memory document with run rationale and next decisions", async () => {
    const company = await store.createCompany({
      name: `Decision Journal ${makeId("test")}`,
      brief: { vision: "Remember CEO choices across cycles" },
    });
    const run = {
      id: "orc_journal_1",
      companyId: company.id,
      objective: "Pick the next growth priority",
      status: "completed",
      trigger: "scheduled",
      fullTeam: true,
      summary: "CEO chose activation because onboarding drop-off was highest.",
      steps: [
        {
          id: "step_ceo",
          title: "Prioritize growth",
          agentRole: "ceo",
          status: "completed",
          output: "Choose activation over acquisition this week.",
        },
      ],
      startedAt: "2026-06-12T00:00:00.000Z",
      completedAt: "2026-06-12T00:05:00.000Z",
    } as OrchestrationRun;

    const document = await persistCeoDecisionJournal(run, [
      { title: "Instrument activation funnel", rationale: "Validate onboarding drop-off", priority: "high" },
    ]);

    expect(document).toMatchObject({
      companyId: company.id,
      type: "agent_note",
      title: "CEO decision journal: Pick the next growth priority",
      source: "ceo-decision-journal:orc_journal_1",
      memoryTier: "semantic",
    });
    expect(document.content).toContain("CEO chose activation");
    expect(document.content).toContain("Instrument activation funnel");
  });
});
