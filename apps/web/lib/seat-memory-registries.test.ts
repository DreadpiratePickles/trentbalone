import { describe, expect, it } from "vitest";
import {
  buildSeatRegistryRecall,
  persistSeatRegistryMemory,
  readSeatRegistryMemory,
} from "@/lib/seat-memory-registries";
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

  it("reads back a seat's registry entries newest-first for the next cycle", async () => {
    const company = await store.createCompany({
      name: `Registry Recall ${makeId("test")}`,
      brief: { vision: "Compound across cycles" },
    });

    await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_cycle_1",
      step: {
        ...step("growth", "Week 1 experiment", "Experiment: paywall A/B, baseline conversion 4%."),
        id: "step_growth_w1",
        completedAt: "2026-06-10T00:00:00.000Z",
      },
    });
    await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_cycle_2",
      step: {
        ...step("growth", "Week 2 experiment", "Experiment: onboarding email, lifted activation to 6%."),
        id: "step_growth_w2",
        completedAt: "2026-06-12T00:00:00.000Z",
      },
    });

    const entries = await readSeatRegistryMemory(company.id, "growth");
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toContain("Week 2 experiment");

    const recall = await buildSeatRegistryRecall(company.id, "growth");
    expect(recall).toContain("EXPERIMENT REGISTRY");
    expect(recall).toContain("registry key: experiments");
    expect(recall).toContain("Week 2 experiment");
    expect(recall).not.toContain("Registry key: experiments\nSeat:"); // header stripped from body
  });

  it("returns empty recall for a seat with no registry or no entries", async () => {
    const company = await store.createCompany({
      name: `Registry Empty ${makeId("test")}`,
      brief: { vision: "Nothing yet" },
    });
    expect(await readSeatRegistryMemory(company.id, "engineer")).toEqual([]);
    expect(await buildSeatRegistryRecall(company.id, "growth")).toBe("");
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
