import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, buildSlotEnvironment } from "@/lib/agent-catalog";
import {
  assertSkillsInstalled,
  resolveSkillsForAgent,
} from "@/lib/agent-skills";
import { listInstalledSkillNames, loadGrantedSkillInstructions } from "@/lib/agent-skill-instructions";
import type { AgentEnvironmentConfig } from "@/lib/types";

describe("Agent Plug skill resolution", () => {
  it("keeps AgentEnvironmentConfig skills copy-safe and independently configurable", () => {
    const base = buildSlotEnvironment("co_skill", "analyst");
    const withSkills: AgentEnvironmentConfig = {
      ...base,
      skills: ["test-driven-development", "verification-before-completion"],
    };

    expect(base.skills).toEqual(expect.arrayContaining([
      "market-research-analysis",
      "competitive-intelligence-analyst",
      "data-report",
    ]));
    expect(withSkills.skills).toEqual(["test-driven-development", "verification-before-completion"]);
  });

  it("merges category defaults and per-agent overrides in stable de-duped order", () => {
    const skills = resolveSkillsForAgent({ id: "eng-code-reviewer", category: "engineering" });

    expect(skills).toEqual([
      "using-superpowers",
      "brainstorming",
      "using-git-worktrees",
      "writing-plans",
      "test-driven-development",
      "subagent-driven-development",
      "requesting-code-review",
      "systematic-debugging",
      "receiving-code-review",
      "verification-before-completion",
      "finishing-a-development-branch",
    ]);
  });

  it("grants the Superpowers methodology bundle to engineering catalog agents", () => {
    const skills = resolveSkillsForAgent({ id: "eng-backend-architect", category: "engineering" });

    expect(skills).toEqual(expect.arrayContaining([
      "using-superpowers",
      "brainstorming",
      "using-git-worktrees",
      "writing-plans",
      "test-driven-development",
      "subagent-driven-development",
      "requesting-code-review",
      "receiving-code-review",
      "verification-before-completion",
      "finishing-a-development-branch",
    ]));
  });

  it("grants UI/UX Pro Max only through design catalog defaults", () => {
    const designSkills = resolveSkillsForAgent({ id: "design-ui-designer", category: "design" });
    const engineeringSkills = resolveSkillsForAgent({ id: "eng-backend-architect", category: "engineering" });

    expect(designSkills).toContain("ui-ux-pro-max");
    expect(engineeringSkills).not.toContain("ui-ux-pro-max");
  });

  it("throws for unknown skills", () => {
    expect(() => assertSkillsInstalled(["verification-before-completion", "missing-skill"])).toThrow(
      "Unknown Agent Plug skill"
    );
  });

  it("keeps the vendored map aligned with installed skill directories", async () => {
    const installed = await listInstalledSkillNames();
    const resolved = new Set(AGENT_CATALOG.flatMap((agent) => resolveSkillsForAgent(agent)));

    for (const skill of resolved) {
      expect(installed).toContain(skill);
    }
  });

  it("populates every catalog agent with at least one skill and verification discipline", () => {
    expect(AGENT_CATALOG.length).toBeGreaterThanOrEqual(160);

    for (const agent of AGENT_CATALOG) {
      expect(agent.skills, agent.id).toBeDefined();
      expect(agent.skills?.length, agent.id).toBeGreaterThan(0);
      expect(agent.skills, agent.id).toContain("verification-before-completion");
    }
  });

  it("loads granted skill instructions only in granted order", async () => {
    const blocks = await loadGrantedSkillInstructions([
      "verification-before-completion",
      "test-driven-development",
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("Skill: verification-before-completion");
    expect(blocks[0]).toContain("Evidence before claims");
    expect(blocks[1]).toContain("Skill: test-driven-development");
    expect(blocks.join("\n")).not.toContain("Skill: frontend-design");
  });

  it("recognizes imported HyperFrames authoring skills", async () => {
    expect(() => assertSkillsInstalled(["hyperframes", "hyperframes-cli"])).not.toThrow();

    const blocks = await loadGrantedSkillInstructions(["hyperframes", "hyperframes-cli"]);
    expect(blocks[0]).toContain("Skill: hyperframes");
    expect(blocks[0]).toContain("HTML is the source of truth for video");
    expect(blocks[1]).toContain("Skill: hyperframes-cli");
    expect(blocks[1]).toContain("npx hyperframes");
  });

  it("recognizes the imported Claude Ads critic skill", async () => {
    expect(() => assertSkillsInstalled(["claude-ads-critic"])).not.toThrow();

    const blocks = await loadGrantedSkillInstructions(["claude-ads-critic"]);
    expect(blocks[0]).toContain("Skill: claude-ads-critic");
    expect(blocks[0]).toContain("paid advertising audit");
    expect(blocks[0]).toContain("approval-gated");
  });

  it("recognizes imported Finance Ledger skills", async () => {
    const financeSkills = [
      "variance-analysis",
      "reconciliation",
      "finance-billing-ops",
      "cfo-advisor",
      "cost-budget-check",
    ];

    expect(() => assertSkillsInstalled(financeSkills)).not.toThrow();

    const blocks = await loadGrantedSkillInstructions(financeSkills);
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "Skill: variance-analysis",
      "Skill: reconciliation",
      "Skill: finance-billing-ops",
      "Skill: cfo-advisor",
      "Skill: cost-budget-check",
    ]);
  });

  it("recognizes imported Studio copy, ideation, and visual explanation skills", async () => {
    const studioSkills = [
      "copywriting",
      "content-creation-and-marketing",
      "frontend-slides",
      "visual-explainer",
    ];

    expect(() => assertSkillsInstalled(studioSkills)).not.toThrow();

    const blocks = await loadGrantedSkillInstructions(studioSkills);
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "Skill: copywriting",
      "Skill: content-creation-and-marketing",
      "Skill: frontend-slides",
      "Skill: visual-explainer",
    ]);
  });

  it("recognizes imported skills for Shield, Lens, Audit, and Pipeline seats", async () => {
    const seatExpansionSkills = [
      "customer-escalation",
      "customer-success",
      "incident-runbook-templates",
      "market-research-analysis",
      "competitive-intelligence-analyst",
      "data-report",
      "risk-assessment",
      "prospecting",
      "predictable-revenue",
    ];

    expect(() => assertSkillsInstalled(seatExpansionSkills)).not.toThrow();

    const blocks = await loadGrantedSkillInstructions(seatExpansionSkills);
    expect(blocks.map((block) => block.split("\n")[0])).toEqual([
      "Skill: customer-escalation",
      "Skill: customer-success",
      "Skill: incident-runbook-templates",
      "Skill: market-research-analysis",
      "Skill: competitive-intelligence-analyst",
      "Skill: data-report",
      "Skill: risk-assessment",
      "Skill: prospecting",
      "Skill: predictable-revenue",
    ]);
  });
});
