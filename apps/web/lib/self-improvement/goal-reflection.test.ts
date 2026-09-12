import { describe, expect, it } from "vitest";
import { deriveSkillDraftsFromGoalRound } from "@/lib/self-improvement/goal-reflection";
import { foldPlaybook, InMemoryCompanyPlaybookLog } from "@/lib/self-improvement/company-playbook";
import type { Company } from "@/lib/types";
import type { Goal } from "@/lib/goal-types";

const company = { id: "co_reflect", name: "Reflect Co" } as Company;
const goal = { id: "goal_1", objective: "Ship the onboarding revamp" } as Goal;

describe("goal reflection → playbook deltas (Task 3.2 emission)", () => {
  it("emits a proven-approach delta for seats with critic-accepted artifacts", async () => {
    const log = new InMemoryCompanyPlaybookLog();

    const result = await deriveSkillDraftsFromGoalRound({
      company,
      goal,
      executed: [
        { seat: "engineer", ok: true, verdict: "pass", objective: "Build the signup flow" },
        { seat: "engineer", ok: true, verdict: "pass", objective: "Add tests" },
      ],
      playbookLog: log,
    });

    expect(result.playbookDeltas).toBe(1);
    const folded = foldPlaybook(await log.list(company.id));
    expect(folded.bullets).toHaveLength(1);
    expect(folded.bullets[0]!.topic).toBe("goal.engineer");
    expect(folded.bullets[0]!.text).toContain("Build the signup flow");
  });

  it("emits a caution delta for seats whose every artifact failed the critic", async () => {
    const log = new InMemoryCompanyPlaybookLog();

    const result = await deriveSkillDraftsFromGoalRound({
      company,
      goal,
      executed: [
        { seat: "growth", ok: false, verdict: "retry", objective: "Draft outreach" },
      ],
      playbookLog: log,
    });

    expect(result.playbookDeltas).toBe(1);
    const folded = foldPlaybook(await log.list(company.id));
    expect(folded.bullets[0]!.topic).toBe("goal.growth.caution");
    expect(folded.bullets[0]!.text).toContain("failed the critic");
  });

  it("repeated rounds revise (latest-wins) instead of duplicating bullets", async () => {
    const log = new InMemoryCompanyPlaybookLog();
    const run = (objective: string) => deriveSkillDraftsFromGoalRound({
      company,
      goal,
      executed: [{ seat: "engineer", ok: true, verdict: "pass", objective }],
      playbookLog: log,
    });

    await run("First artifact");
    await run("Second artifact");

    const entries = await log.list(company.id);
    expect(entries).toHaveLength(2); // append-only log keeps both deltas…
    const folded = foldPlaybook(entries);
    expect(folded.bullets).toHaveLength(1); // …but the folded playbook has one bullet
    expect(folded.bullets[0]!.text).toContain("Second artifact");
  });

  it("emits nothing for an empty round", async () => {
    const log = new InMemoryCompanyPlaybookLog();
    const result = await deriveSkillDraftsFromGoalRound({ company, goal, executed: [], playbookLog: log });

    expect(result).toEqual({ draftsWritten: 0, playbookDeltas: 0 });
    expect(await log.list(company.id)).toEqual([]);
  });
});
