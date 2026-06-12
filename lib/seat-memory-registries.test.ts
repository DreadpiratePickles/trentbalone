import { describe, expect, it } from "vitest";
import { persistSeatRegistryMemory } from "@/lib/seat-memory-registries";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestratorStep } from "@/lib/types";

describe("seat memory registries", () => {
  it("persists growth, sales, and content registry updates as semantic memory", async () => {
    const company = await store.createCompany({
      name: `Registry Memory ${makeId("test")}`,
      brief: { vision: "Compound agent memory" },
    });

    const growth = await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_registry_1",
      step: step("growth", "Draft activation experiment", "Experiment: test onboarding proof email against baseline."),
    });
    const sales = await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_registry_1",
      step: step("sales", "Qualify pipeline", "Pipeline: move ACME to qualified follow-up next week."),
    });
    const content = await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_registry_1",
      step: step("content", "Plan posts", "Calendar: schedule proof post for Monday."),
    });

    expect(growth).toMatchObject({
      memoryTier: "semantic",
      source: "seat-registry:growth:orc_registry_1:step_growth",
      title: "Experiment registry: Draft activation experiment",
    });
    expect(growth?.content).toContain("Registry key: experiments");
    expect(growth?.content).toContain("test onboarding proof email");
    expect(sales?.content).toContain("Registry key: pipelineState");
    expect(content?.content).toContain("Registry key: contentCalendar");
  });

  it("skips seats without durable registries", async () => {
    const company = await store.createCompany({
      name: `Registry Skip ${makeId("test")}`,
      brief: { vision: "Only specialist registries" },
    });

    const document = await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_registry_2",
      step: step("engineer", "Run tests", "Tests passed."),
    });

    expect(document).toBeUndefined();
  });
});

function step(agentRole: OrchestratorStep["agentRole"], title: string, output: string): OrchestratorStep {
  return {
    id: `step_${agentRole}`,
    runId: "orc_registry_1",
    companyId: "co_registry",
    seq: 1,
    title,
    rationale: "Needed for compounding memory",
    agentRole,
    dependsOn: [],
    expectedOutput: "Registry update",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    output,
    completedAt: "2026-06-12T00:00:00.000Z",
  };
}
