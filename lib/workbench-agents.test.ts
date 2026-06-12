import { describe, expect, it } from "vitest";
import { buildWorkbenchAgentObjective, getWorkbenchAgents } from "@/lib/workbench-agents";

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
});
