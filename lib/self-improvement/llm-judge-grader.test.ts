import { describe, it, expect, vi } from "vitest";
import { runEvalSuite } from "@/lib/eval-harness";
import { RecordedActualsProvider } from "@/lib/self-improvement/actuals-provider";
import { buildSkillEvalSuite, type SkillEvalsJson } from "@/lib/self-improvement/frozen-suite";
import {
  judgeAssertions,
  buildJudgedGradersFor,
  type JudgeFn,
} from "@/lib/self-improvement/llm-judge-grader";

const SKILL: SkillEvalsJson = {
  skill_name: "ads",
  evals: [
    { id: 1, prompt: "Plan a paid ads budget", assertions: ["mentions a budget", "names a channel"] },
    { id: 2, prompt: "Say hi", assertions: [] },
  ],
};

/** A deterministic stub judge: passes when the actual text contains the rubric's key word. */
const stubJudge: JudgeFn = async ({ rubric, actual }) => {
  const text = (actual.text ?? "").toLowerCase();
  if (rubric.includes("budget")) return { pass: text.includes("budget"), score: text.includes("budget") ? 1 : 0 };
  if (rubric.includes("channel")) return { pass: text.includes("linkedin") || text.includes("google") };
  return { pass: text.trim().length > 0 };
};

describe("llm-judge-grader — turns llm_rubric into real scores (Slice 2)", () => {
  it("judgeAssertions attaches a real verdict to each llm_rubric grader", async () => {
    const graders = await judgeAssertions(
      ["mentions a budget"],
      { input: "Plan a budget", actual: { text: "Recommend a $5k budget." } },
      stubJudge,
    );
    expect(graders).toHaveLength(1);
    expect(graders[0].type).toBe("llm_rubric");
    expect(graders[0]).toMatchObject({ verdict: { pass: true } });
  });

  it("falls back to a default rubric when a fixture has no assertions", async () => {
    const judge = vi.fn(stubJudge);
    const graders = await judgeAssertions([], { actual: { text: "hello there" } }, judge);
    expect(graders).toHaveLength(1);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(graders[0]).toMatchObject({ verdict: { pass: true } });
  });

  it("end-to-end: a passing candidate scores 1, a failing one scores 0 with a rubric_failed cluster", async () => {
    // Candidate output satisfies both assertions on eval 1.
    const good = new RecordedActualsProvider({
      "ads:1": { text: "Recommend a $5k monthly budget split across LinkedIn and Google." },
      "ads:2": { text: "Hi!" },
    });
    const gradersForGood = await buildJudgedGradersFor(SKILL, good, stubJudge);
    const goodSuite = await runEvalSuite({
      ...buildSkillEvalSuite({ skill: SKILL, actuals: good, gradersFor: gradersForGood }),
      subjectId: "cand_good",
    });
    expect(goodSuite.score).toBe(1);
    expect(goodSuite.failureClusters).toEqual({});

    // Candidate output misses the budget + channel → real failure, not a 0.75 "pending".
    const bad = new RecordedActualsProvider({
      "ads:1": { text: "Here is some ad copy with no spend guidance." },
      "ads:2": { text: "Hi!" },
    });
    const gradersForBad = await buildJudgedGradersFor(SKILL, bad, stubJudge);
    const badSuite = await runEvalSuite({
      ...buildSkillEvalSuite({ skill: SKILL, actuals: bad, gradersFor: gradersForBad }),
      subjectId: "cand_bad",
    });
    expect(badSuite.score).toBeLessThan(1);
    expect(badSuite.failureClusters.rubric_failed).toBeGreaterThanOrEqual(1);
    // Crucially: the old "pending" path is gone — no llm_judge_pending tag remains.
    expect(badSuite.failureClusters.llm_judge_pending).toBeUndefined();
  });
});
