import { describe, it, expect } from "vitest";
import { agentSystemPrompt, createDefaultAgents } from "@/lib/agents";
import type { AgentRole } from "@/lib/types";

const ALL_ROLES: AgentRole[] = [
  "ceo", "engineer", "growth", "content", "support", "analyst", "finance", "escalation", "sales",
];

describe("agentSystemPrompt", () => {
  it("includes the shared self-evolution skill-reuse stance for every role", () => {
    for (const role of ALL_ROLES) {
      expect(agentSystemPrompt(role)).toContain("Skill reuse");
    }
  });

  it("gives each role its OpenSpace-derived behavior", () => {
    expect(agentSystemPrompt("ceo")).toContain("Skill-health watch");
    expect(agentSystemPrompt("engineer")).toContain("Tool-degradation duty");
    expect(agentSystemPrompt("growth")).toContain("DERIVED");
    expect(agentSystemPrompt("content")).toContain("Capture what wins");
    expect(agentSystemPrompt("support")).toContain("Verify before the gate");
    expect(agentSystemPrompt("analyst")).toContain("CAPTURED");
    expect(agentSystemPrompt("finance")).toContain("Own token efficiency");
    expect(agentSystemPrompt("escalation")).toContain("Guard the skill gate");
    expect(agentSystemPrompt("sales")).toContain("Specialize qualification");
  });

  it("still carries the safety hard stops", () => {
    for (const role of ALL_ROLES) {
      expect(agentSystemPrompt(role)).toContain("Safety hard stops");
    }
  });
});

describe("createDefaultAgents", () => {
  it("seeds all nine roles for a company", () => {
    const agents = createDefaultAgents("c1");
    expect(agents).toHaveLength(9);
    expect(new Set(agents.map((a) => a.role))).toEqual(new Set(ALL_ROLES));
    expect(agents.every((a) => a.companyId === "c1" && a.enabled)).toBe(true);
  });
});
