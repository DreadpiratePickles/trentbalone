import { describe, expect, it } from "vitest";
import type { CatalogAgent } from "@/lib/agent-catalog";
import {
  computeCapabilityScore,
  deriveQualityLabel,
  evaluateCodeGrader,
  runEvalSuite,
} from "@/lib/plug-evals";
import type { EvalTask, TrialResult } from "@/lib/plug-evals";

const baseAgent: CatalogAgent = {
  id: "eng-test-agent",
  name: "Test Agent",
  emoji: "T",
  category: "engineering",
  specialties: "Testing",
  whenToUse: "Testing",
  color: "#000000",
  file: "engineering/test.md",
};

describe("Plug eval capability scoring", () => {
  it("computes capability score from held-out capability trials only", () => {
    const trials: TrialResult[] = [
      { taskId: "train-cap", taskKind: "capability", split: "train", passed: true, score: 1, transcriptPath: "runs/train.md" },
      { taskId: "heldout-pass", taskKind: "capability", split: "heldout", passed: true, score: 1, transcriptPath: "runs/pass.md" },
      { taskId: "heldout-half", taskKind: "capability", split: "heldout", passed: false, score: 0.5, transcriptPath: "runs/half.md" },
      { taskId: "reg-pass", taskKind: "regression", split: "heldout", passed: true, score: 1, transcriptPath: "runs/reg.md" },
    ];

    expect(computeCapabilityScore(trials)).toBe(75);
  });

  it("never promotes agents with irreversible actions to autonomous", () => {
    const trials = Array.from({ length: 5 }, (_, index): TrialResult => ({
      taskId: `cap-${index}`,
      taskKind: "capability",
      split: "heldout",
      passed: true,
      score: 1,
      transcriptPath: `runs/${index}.md`,
    }));
    const agent: CatalogAgent = {
      ...baseAgent,
      reversibilityMatrix: { reversible: ["read"], costlyToReverse: [], irreversible: ["github_merge_pr"] },
    };

    expect(deriveQualityLabel(agent, 100, trials)).toBe("supervised");
  });

  it("keeps money, send, and production actions supervised regardless of score", () => {
    const trials = Array.from({ length: 5 }, (_, index): TrialResult => ({
      taskId: `cap-${index}`,
      taskKind: "capability",
      split: "heldout",
      passed: true,
      score: 1,
      transcriptPath: `runs/${index}.md`,
    }));
    const agent: CatalogAgent = {
      ...baseAgent,
      reversibilityMatrix: { reversible: ["read"], costlyToReverse: ["gmail.send"], irreversible: [] },
    };

    expect(deriveQualityLabel(agent, 100, trials)).toBe("supervised");
  });

  it("promotes reversible high-score agents to autonomous only after repeated held-out passes", () => {
    const trials = Array.from({ length: 5 }, (_, index): TrialResult => ({
      taskId: `cap-${index}`,
      taskKind: "capability",
      split: "heldout",
      passed: true,
      score: 1,
      transcriptPath: `runs/${index}.md`,
    }));

    expect(deriveQualityLabel(baseAgent, 95, trials)).toBe("autonomous");
  });

  it("evaluates objective code graders without model keys", async () => {
    const regexTask: EvalTask = {
      id: "cap-regex",
      kind: "capability",
      split: "heldout",
      desc: "Require Zod boundary validation",
      graders: [{ kind: "code", check: "regex", pattern: "\\bz\\.object\\(" }],
      passMetric: "pass@1",
    };

    const grader = regexTask.graders[0];
    if (!grader || grader.kind !== "code") throw new Error("expected code grader");
    const result = await evaluateCodeGrader(grader, "const schema = z.object({ email: z.string().email() });");

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("runs local code eval tasks and does not mutate the catalog agent", async () => {
    const agent: CatalogAgent = {
      ...baseAgent,
      evalSuite: {
        capability: [
          {
            id: "cap-string",
            kind: "capability",
            split: "heldout",
            desc: "Find required phrase",
            graders: [{ kind: "code", check: "includes", value: "Definition of done" }],
            passMetric: "pass@1",
          },
        ],
        regression: [],
      },
    };

    const trials = await runEvalSuite(agent, {
      transcriptForTask: () => "Definition of done includes tests and verification.",
    });

    expect(trials).toHaveLength(1);
    expect(trials[0]?.passed).toBe(true);
    expect(agent.capability?.score).toBeUndefined();
  });
});
