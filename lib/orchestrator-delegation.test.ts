import { describe, expect, it } from "vitest";
import {
  buildDelegatedStepsForWorkRequests,
  capabilityToRole,
  decideDelegation,
} from "@/lib/orchestrator-delegation";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import type { WorkRequest } from "@/lib/planner";

describe("capabilityToRole", () => {
  it("routes known capabilities to the specialist seat", async () => {
    expect(await capabilityToRole("write code and open a pull request")).toBe("engineer");
    expect(await capabilityToRole("run a paid ads campaign")).toBe("growth");
    expect(await capabilityToRole("handle a customer escalation")).toBe("support");
    expect(await capabilityToRole("use Fincept for budget variance")).toBe("finance");
  });

  it("does not route CEO-only operating skills back into a delegated CEO loop", async () => {
    expect(await capabilityToRole("set-okrs-goals")).toBeNull();
    expect(await capabilityToRole("gtm-operating-cadence")).toBeNull();
  });
});

describe("decideDelegation", () => {
  const base = {
    requesterRole: "ceo" as const,
    parentDepth: 0,
    seenCapabilities: new Set<string>(),
    delegatedSoFar: 0,
  };

  it("routes a real cross-seat request to the owning specialist", async () => {
    const decision = await decideDelegation({ ...base, capability: "write launch blog post" });
    expect(decision.accepted).toBe(true);
    if (decision.accepted) {
      expect(decision.role).toBe("content");
      expect(decision.depth).toBe(1);
    }
  });

  it("blocks self-delegation or unroutable CEO work", async () => {
    const decision = await decideDelegation({ ...base, capability: "set okrs goals" });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/no seat owns|self-delegation/i);
  });

  it("rejects an explicit self-delegation to the same role", async () => {
    const decision = await decideDelegation({
      ...base,
      requesterRole: "engineer",
      capability: "build the deploy pipeline",
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/self-delegation/i);
  });

  it("deduplicates a capability already delegated in this run", async () => {
    const seen = new Set<string>(["analyze retention metrics"]);
    const decision = await decideDelegation({ ...base, capability: "Analyze retention metrics", seenCapabilities: seen });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/already delegated/i);
  });

  it("stops delegation past the depth cap", async () => {
    const decision = await decideDelegation({ ...base, capability: "run growth experiment", parentDepth: 2 });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/depth/i);
  });

  it("stops delegation once the per-run budget is exhausted", async () => {
    const decision = await decideDelegation({ ...base, capability: "run growth experiment", delegatedSoFar: 6 });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reason).toMatch(/budget/i);
  });

  it("rejects an empty capability", async () => {
    const decision = await decideDelegation({ ...base, capability: "   " });
    expect(decision.accepted).toBe(false);
  });
});

describe("buildDelegatedStepsForWorkRequests", () => {
  it("skips unroutable or same-seat requests instead of creating self-delegation loops", async () => {
    const result = await buildDelegatedStepsForWorkRequests({
      runId: "orc_1",
      companyId: "co_1",
      sourceStep: step({ id: "s1", agentRole: "ceo" }),
      existingSteps: [step({ id: "s1", agentRole: "ceo" })],
      requests: [request("set-okrs-goals")],
      makeIdFn: () => "step_1",
    });

    expect(result.steps).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("unroutable");
  });

  it("creates one delegated step for a routable specialist request", async () => {
    const result = await buildDelegatedStepsForWorkRequests({
      runId: "orc_1",
      companyId: "co_1",
      sourceStep: step({ id: "s1", agentRole: "ceo" }),
      existingSteps: [step({ id: "s1", agentRole: "ceo" })],
      requests: [request("write code for the notes app")],
      makeIdFn: () => "step_2",
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      id: "step_2",
      agentRole: "engineer",
      dependsOn: ["s1"],
      title: "[delegated] write code for the notes app",
      status: "pending",
    });
  });

  it("dedupes repeated delegated capabilities", async () => {
    const result = await buildDelegatedStepsForWorkRequests({
      runId: "orc_1",
      companyId: "co_1",
      sourceStep: step({ id: "s1", agentRole: "ceo" }),
      existingSteps: [
        step({ id: "s1", agentRole: "ceo" }),
        step({ id: "s2", agentRole: "engineer", title: "[delegated] write code for the notes app" }),
      ],
      requests: [request("write code for the notes app"), request("write code for the notes app")],
      makeIdFn: () => "step_3",
    });

    expect(result.steps).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason).join(" ")).toContain("duplicate");
  });
});

function step(overrides: Partial<StepRecord>): StepRecord {
  return {
    id: overrides.id ?? "s1",
    title: overrides.title ?? "Plan work",
    rationale: "test",
    agentRole: overrides.agentRole ?? "ceo",
    dependsOn: [],
    expectedOutput: "output",
    riskLevel: "low",
    needsApproval: false,
    status: "pending",
    ...overrides,
  };
}

function request(capability: string): WorkRequest {
  return {
    id: `wreq_${capability}`,
    cycleId: "orc_1",
    companyId: "co_1",
    requester: "ceo",
    capability,
    input: null,
    budgetCents: 100,
    depth: 0,
  };
}
