import { describe, expect, it } from "vitest";
import {
  buildWorkbenchAgentObjective,
  buildWorkbenchAgentsFromContracts,
  getWorkbenchAgents,
  summarizeWorkbenchAgentTools,
} from "@/lib/workbench-agents";
import type { SeatToolContract } from "@/lib/seat-tool-contracts";

function contract(input: Partial<SeatToolContract> & Pick<SeatToolContract, "seat" | "tool" | "readiness">): SeatToolContract {
  return {
    binding: "internal_action",
    resolvedAdapter: null,
    advertised: true,
    approvalRequired: false,
    writeCapable: false,
    ...input,
  };
}

describe("workbench agents", () => {
  it("exposes real agent seats without fake app catalog cards", () => {
    const agents = getWorkbenchAgents();

    expect(agents.map((agent) => agent.role)).toEqual([
      "ceo",
      "engineer",
      "growth",
      "content",
      "support",
      "finance",
      "analyst",
      "escalation",
      "sales",
    ]);
    expect(JSON.stringify(agents)).not.toContain("Fincept Terminal");
    expect(JSON.stringify(agents)).not.toContain("Ghostfolio");
    expect(JSON.stringify(agents)).not.toContain("Steel Browser");
  });

  it("builds a Workbench-scoped objective with contract evidence", () => {
    const engineer = getWorkbenchAgents().find((agent) => agent.role === "engineer");

    expect(engineer).toBeDefined();
    expect(engineer?.mode).toBe("build");
    expect(buildWorkbenchAgentObjective(engineer!, "Repair the dashboard")).toContain("[workbench-agent] Engineer");
    expect(buildWorkbenchAgentObjective(engineer!, "Repair the dashboard")).toContain("Evidence required:");
    expect(buildWorkbenchAgentObjective(engineer!, "Repair the dashboard")).not.toContain("[app-solo]");
  });

  it("derives Workbench agent tools from seat-tool contracts and preserves readiness", () => {
    const engineer = buildWorkbenchAgentsFromContracts([
      contract({ seat: "engineer", tool: "tasks:create", readiness: "internal", writeCapable: true, approvalRequired: true }),
      contract({
        seat: "engineer",
        tool: "Workbench Sandbox",
        binding: "adapter_name",
        resolvedAdapter: "Workbench Sandbox",
        readiness: "mocked",
        notes: "local deterministic fallback",
      }),
      contract({
        seat: "engineer",
        tool: "GitHub",
        binding: "adapter_name",
        resolvedAdapter: "GitHub",
        readiness: "needs_credentials",
      }),
      contract({ seat: "engineer", tool: "phantom:tool", readiness: "unavailable", advertised: false }),
      contract({ seat: "engineer", tool: "Fincept Terminal", readiness: "connected" }),
    ]).find((agent) => agent.role === "engineer");

    expect(engineer).toBeDefined();
    expect(engineer?.tools.map((tool) => tool.name)).toEqual(["tasks:create", "Workbench Sandbox", "GitHub"]);
    expect(engineer?.tools).toEqual([
      expect.objectContaining({
        name: "tasks:create",
        status: "real",
        readiness: "internal",
        writeCapable: true,
        approvalRequired: true,
      }),
      expect.objectContaining({
        name: "Workbench Sandbox",
        status: "test_only",
        readiness: "mocked",
        reason: "local deterministic fallback",
      }),
      expect.objectContaining({
        name: "GitHub",
        status: "unavailable",
        readiness: "needs_credentials",
        reason: "needs provider credentials",
      }),
    ]);
    expect(summarizeWorkbenchAgentTools(engineer!)).toContain("tasks:create [real; internal; approval-required; write-capable]");
  });

  it("includes readiness and approval truth in the Workbench agent prompt", () => {
    const engineer = buildWorkbenchAgentsFromContracts([
      contract({ seat: "engineer", tool: "tasks:create", readiness: "internal", writeCapable: true, approvalRequired: true }),
      contract({
        seat: "engineer",
        tool: "GitHub",
        binding: "adapter_name",
        resolvedAdapter: "GitHub",
        readiness: "needs_credentials",
      }),
    ]).find((agent) => agent.role === "engineer");

    expect(engineer).toBeDefined();
    const objective = buildWorkbenchAgentObjective(engineer!, "Open a PR");

    expect(objective).toContain("tasks:create (real; readiness=internal; approval-required; write-capable)");
    expect(objective).toContain("GitHub (unavailable; readiness=needs_credentials; needs provider credentials)");
  });
});
