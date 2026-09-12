import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { persistSeatRegistryMemory } from "@/lib/seat-memory-registries";
import { persistCeoDecisionJournal } from "@/lib/ceo-decision-journal";
import { clearAgentRuntimeCache, getAgentRuntime } from "@/lib/agent-runtime";
import type { OrchestrationRun } from "@/lib/orchestrator";
import type { OrchestratorStep } from "@/lib/types";

/**
 * Parity ledger Item 3 done-bar: "run two cycles a day apart; the second cycle
 * visibly references a decision/experiment written by the first." This exercises
 * the real write path (cycle 1) and the real runtime recall (cycle 2) against the
 * in-process store — no live providers or DB required.
 */
describe("memory compounding across cycles", () => {
  it("cycle 2 growth runtime recalls cycle 1's experiment registry", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: `Compounding ${makeId("test")}`,
      brief: { vision: "Compound experiments across cycles" },
    });

    // --- Cycle 1: growth seat writes an experiment registry entry ---
    await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_cycle_1",
      step: growthStep(company.id),
    });

    // --- Cycle 2: a fresh runtime build must recall the cycle-1 experiment ---
    const growth = await getAgentRuntime(company.id, "growth");
    expect(growth.dynamicPrompt).toContain("EXPERIMENT REGISTRY");
    expect(growth.dynamicPrompt).toContain("EXP-PAYWALL-01");
    expect(growth.dynamicPrompt).toContain("baseline conversion 4%");
  });

  it("cycle 2 CEO runtime recalls cycle 1's decision journal", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: `Compounding CEO ${makeId("test")}`,
      brief: { vision: "CEO remembers prior decisions" },
    });

    // --- Cycle 1: CEO records a decision with rationale ---
    const run = {
      id: "orc_cycle_1",
      companyId: company.id,
      objective: "Set the Q3 north-star metric",
      status: "completed",
      trigger: "scheduled",
      completedAt: "2026-06-12T00:00:00.000Z",
      summary: "Chose activation rate as the north-star; deprioritized paid ads this quarter.",
      steps: [
        { agentRole: "ceo", title: "Decide north-star", output: "Activation rate over raw signups." },
      ],
    } as unknown as OrchestrationRun;
    await persistCeoDecisionJournal(run, [
      { title: "Hold paid ads", rationale: "CAC is too high right now", priority: "high" },
    ]);

    // --- Cycle 2: a fresh CEO runtime must recall the cycle-1 decision ---
    const ceo = await getAgentRuntime(company.id, "ceo");
    expect(ceo.dynamicPrompt.toLowerCase()).toContain("ceo decision journal");
    expect(ceo.dynamicPrompt.toLowerCase()).toContain("activation rate");
  });

  it("does not leak one seat's registry into an unrelated seat", async () => {
    clearAgentRuntimeCache();
    const company = await store.createCompany({
      name: `Compounding Isolation ${makeId("test")}`,
      brief: { vision: "Per-seat registries stay scoped" },
    });
    await persistSeatRegistryMemory({
      companyId: company.id,
      runId: "orc_cycle_1",
      step: growthStep(company.id),
    });

    const engineer = await getAgentRuntime(company.id, "engineer");
    expect(engineer.dynamicPrompt).not.toContain("EXPERIMENT REGISTRY");
  });
});

function growthStep(companyId: string): OrchestratorStep {
  return {
    id: "step_growth_c1",
    runId: "orc_cycle_1",
    companyId,
    seq: 1,
    title: "Paywall experiment",
    rationale: "Test pricing friction",
    agentRole: "growth",
    dependsOn: [],
    expectedOutput: "Experiment registry update",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    output: "Experiment EXP-PAYWALL-01: A/B paywall vs baseline, baseline conversion 4%.",
    completedAt: "2026-06-12T00:00:00.000Z",
  };
}
