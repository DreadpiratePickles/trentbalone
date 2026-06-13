import { describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationRun } from "@/lib/orchestrator";

const { mockCeoChatResponse, mockConsolidateRun, mockAuditTransition, mockAssembleMorningBriefing } = vi.hoisted(() => ({
  mockCeoChatResponse: vi.fn(),
  mockConsolidateRun: vi.fn(),
  mockAuditTransition: vi.fn(),
  mockAssembleMorningBriefing: vi.fn(),
}));

vi.mock("@/lib/ai", () => ({
  ceoChatResponse: mockCeoChatResponse,
}));

vi.mock("@/lib/orchestrator-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orchestrator-runtime")>();
  return {
    ...actual,
    auditTransition: mockAuditTransition,
    consolidateRun: mockConsolidateRun,
  };
});

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();
  return {
    ...actual,
    assembleMorningBriefing: mockAssembleMorningBriefing,
  };
});

import { processConsolidatePhase } from "@/lib/orchestrator-run-phases";

describe("nightly durable cycle briefing", () => {
  it("assembles the founder morning briefing only after the scheduled durable run consolidates", async () => {
    mockCeoChatResponse.mockResolvedValue({ suggestions: [] });
    mockConsolidateRun.mockResolvedValue("CEO summary: completed nightly operating cycle.");
    mockAssembleMorningBriefing.mockResolvedValue({ id: "report_morning" });
    const company = await store.createCompany({
      name: `Completed Nightly ${makeId("test")}`,
      brief: { vision: "Send the briefing after the run is real" },
      cycleFrequency: "manual",
    });
    await store.updateCompany(company.id, {
      nightlyRunHour: 5,
      nextCycleAt: undefined,
      lastCycleAt: undefined,
    });
    const run: OrchestrationRun = {
      id: `orc_nightly_${makeId("test")}`,
      companyId: company.id,
      objective: "Inspect company state for this scheduled operating cycle.",
      status: "running",
      trigger: "scheduled",
      fullTeam: true,
      startedAt: "2026-06-12T05:00:00.000Z",
      cycleId: `cycle_nightly_${makeId("test")}`,
      plan: {
        objective: "Inspect company state",
        reasoning: "Nightly cycle",
        steps: [],
        successCriteria: ["CEO summary"],
        blockers: [],
      },
      steps: [
        {
          id: "s1",
          title: "Consolidate outcome",
          rationale: "Founder briefing",
          agentRole: "ceo",
          dependsOn: [],
          expectedOutput: "CEO summary",
          riskLevel: "low",
          needsApproval: false,
          status: "completed",
          output: "Completed safe work and queued approvals.",
          completedAt: "2026-06-12T05:10:00.000Z",
        },
      ],
    };
    await store.saveCycle({
      id: run.cycleId!,
      companyId: company.id,
      trigger: "scheduled",
      kind: "scheduled",
      status: "running",
      phases: ["plan", "execute", "consolidate"],
      summary: run.objective,
      startedAt: run.startedAt,
    });
    await store.createOrchestratorRun({
      id: run.id,
      companyId: company.id,
      objective: run.objective,
      trigger: "scheduled",
      status: "running",
      modelPolicy: {},
      budgetCents: 1000,
      costCents: 0,
      replanCount: 0,
      cycleId: run.cycleId,
      startedAt: run.startedAt,
    });

    await processConsolidatePhase(run, company);

    expect(mockAssembleMorningBriefing).toHaveBeenCalledWith(company.id);
  });
});
