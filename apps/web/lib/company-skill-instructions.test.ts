/**
 * Tests for the loadCompanySkillInstructions function (Phase 3 of the
 * self-improvement loop) added to agent-skill-instructions.ts.
 */
import { describe, it, expect } from "vitest";
import { loadCompanySkillInstructions, buildCompanySkillPrelude } from "@/lib/agent-skill-instructions";
import { InMemorySkillDraftStore } from "@/lib/skill-foundry";

const SKILL_CHURN = `---
name: churn-analysis
description: Analyze customer churn cohorts
version: 1.0.0
metadata:
  trent:
    taskType: churn_analysis
---

## Steps
1. Pull retention cohort data
2. Segment by acquisition channel
3. Chart the retention curve
`;

const SKILL_GROWTH = `---
name: growth-experiment
description: Design and measure a growth experiment
version: 1.0.0
metadata:
  trent:
    taskType: growth_experiment
---

## Steps
1. Define hypothesis
2. Set up tracking
3. Run experiment
`;

async function makeStore(companyId: string, skills: Record<string, string>): Promise<InMemorySkillDraftStore> {
  const s = new InMemorySkillDraftStore();
  for (const [taskType, content] of Object.entries(skills)) {
    await s.writeQuarantine(companyId, taskType, content);
    await s.promote(companyId, taskType);
  }
  return s;
}

describe("loadCompanySkillInstructions", () => {
  it("returns an empty array when no live skills exist", async () => {
    const store = await makeStore("c1", {});
    const blocks = await loadCompanySkillInstructions("c1", store);
    expect(blocks).toHaveLength(0);
  });

  it("returns blocks for all live skills when no taskType filter", async () => {
    const store = await makeStore("c1", {
      churn_analysis: SKILL_CHURN,
      growth_experiment: SKILL_GROWTH,
    });
    const blocks = await loadCompanySkillInstructions("c1", store);
    expect(blocks).toHaveLength(2);
  });

  it("prefixes each block with 'Skill (company): <taskType>'", async () => {
    const store = await makeStore("c1", { churn_analysis: SKILL_CHURN });
    const [block] = await loadCompanySkillInstructions("c1", store);
    expect(block).toMatch(/^Skill \(company\): churn_analysis/);
  });

  it("strips YAML frontmatter from the skill content", async () => {
    const store = await makeStore("c1", { churn_analysis: SKILL_CHURN });
    const [block] = await loadCompanySkillInstructions("c1", store);
    expect(block).not.toContain("name: churn-analysis");
    expect(block).toContain("## Steps");
  });

  it("ranks exact-match task type first", async () => {
    const store = await makeStore("c1", {
      churn_analysis: SKILL_CHURN,
      growth_experiment: SKILL_GROWTH,
    });
    const blocks = await loadCompanySkillInstructions("c1", store, { taskType: "churn_analysis" });
    expect(blocks[0]).toContain("churn_analysis");
  });

  it("respects maxSkills limit", async () => {
    const store = await makeStore("c1", {
      skill_a: "## a",
      skill_b: "## b",
      skill_c: "## c",
    });
    const blocks = await loadCompanySkillInstructions("c1", store, { maxSkills: 2 });
    expect(blocks).toHaveLength(2);
  });

  it("does not cross company boundaries", async () => {
    const store = await makeStore("c1", { churn_analysis: SKILL_CHURN });
    await store.writeQuarantine("c2", "growth_experiment", SKILL_GROWTH);
    await store.promote("c2", "growth_experiment");
    const blocks = await loadCompanySkillInstructions("c1", store);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("churn_analysis");
  });

  it("sorts alphabetically by taskType when no taskType filter", async () => {
    const store = await makeStore("c1", { zzz_skill: "## z", aaa_skill: "## a" });
    const blocks = await loadCompanySkillInstructions("c1", store);
    expect(blocks[0]).toContain("aaa_skill");
    expect(blocks[1]).toContain("zzz_skill");
  });
});

describe("buildCompanySkillPrelude", () => {
  it("returns applied=false and an empty prelude when no live skills exist", async () => {
    const store = await makeStore("c1", {});
    const { prelude, applied } = await buildCompanySkillPrelude("c1", store, "analyze churn");
    expect(applied).toBe(false);
    expect(prelude).toBe("");
  });

  it("builds a reuse prelude and marks applied when a live skill matches", async () => {
    const store = await makeStore("c1", { churn_analysis: SKILL_CHURN });
    const { prelude, applied } = await buildCompanySkillPrelude(
      "c1",
      store,
      "analyze churn cohort retention",
    );
    expect(applied).toBe(true);
    expect(prelude).toContain("Reusable skills for this task");
    expect(prelude).toContain("Pull retention cohort data");
  });

  it("caps the number of injected skills", async () => {
    const store = await makeStore("c1", {
      a_skill: "## a", b_skill: "## b", c_skill: "## c",
    });
    const { prelude } = await buildCompanySkillPrelude("c1", store, "anything", 2);
    const count = (prelude.match(/Skill \(company\):/g) ?? []).length;
    expect(count).toBe(2);
  });
});
