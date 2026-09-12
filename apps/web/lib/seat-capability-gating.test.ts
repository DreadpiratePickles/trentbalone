import { describe, expect, it } from "vitest";
import { buildSlotEnvironment } from "@/lib/agent-catalog";
import { clearAgentRuntimeCache, getAgentRuntime } from "@/lib/agent-runtime";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import {
  applySeatCapabilityGate,
  computeSeatCapabilityGateDecision,
  recordSeatCapabilityGateDecision,
} from "@/lib/seat-capability-gating";

describe("seat capability gating", () => {
  it("promotes high-scoring seats by removing only reversible approval gates", () => {
    const environment = buildSlotEnvironment("co_capability", "engineer");

    const decision = computeSeatCapabilityGateDecision({
      role: "engineer",
      score: 94,
      criticFlagRate: 0.02,
      currentQualityLabel: "supervised",
      approvalRequiredFor: environment.approvalRequiredFor,
    });
    const gated = applySeatCapabilityGate(environment, decision);

    expect(decision.action).toBe("promote");
    expect(decision.qualityLabel).toBe("autonomous");
    expect(decision.removedApprovalGates).toEqual(expect.arrayContaining(["github.issue", "github.branch"]));
    expect(gated.approvalRequiredFor).not.toContain("github.issue");
    expect(gated.approvalRequiredFor).not.toContain("github.branch");
    expect(gated.approvalRequiredFor).toEqual(expect.arrayContaining(["github.pr", "github.merge", "deploy"]));
  });

  it("demotes seats when critic flags spike and preserves supervised gates", () => {
    const environment = buildSlotEnvironment("co_capability", "analyst");

    const decision = computeSeatCapabilityGateDecision({
      role: "analyst",
      score: 91,
      criticFlagRate: 0.21,
      currentQualityLabel: "autonomous",
      approvalRequiredFor: environment.approvalRequiredFor,
    });
    const gated = applySeatCapabilityGate(environment, decision);

    expect(decision.action).toBe("demote");
    expect(decision.qualityLabel).toBe("supervised");
    expect(gated.approvalRequiredFor).toEqual(environment.approvalRequiredFor);
  });

  it("persists the decision as semantic memory and audit evidence used by the next runtime", async () => {
    const company = await store.createCompany({
      name: `Capability Gate ${makeId("test")}`,
      brief: { vision: "Score seats honestly" },
    });
    const environment = buildSlotEnvironment(company.id, "engineer");
    const decision = computeSeatCapabilityGateDecision({
      role: "engineer",
      score: 96,
      criticFlagRate: 0,
      currentQualityLabel: "supervised",
      approvalRequiredFor: environment.approvalRequiredFor,
    });

    await recordSeatCapabilityGateDecision({
      companyId: company.id,
      role: "engineer",
      decision,
    });
    clearAgentRuntimeCache();
    const runtime = await getAgentRuntime(company.id, "engineer");
    const audits = await store.listAuditLogs(company.id);

    expect(runtime.environment.approvalRequiredFor).not.toContain("github.issue");
    expect(runtime.dynamicPrompt).toContain("CAPABILITY GATE");
    expect(runtime.dynamicPrompt).toContain("score: 96");
    expect(audits.some((audit) =>
      audit.action === "agent.capability_gate" &&
      audit.summary.includes("engineer promoted to autonomous")
    )).toBe(true);
  });
});
