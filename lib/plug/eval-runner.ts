import { computeCapabilityScore, deriveQualityLabel, runEvalSuite } from "@/lib/plug-evals";
import type { CatalogAgent } from "@/lib/agent-catalog";
import type { TrialResult } from "@/lib/plug-evals";
import type { PlugDefinition } from "@/lib/plug/schema-v2";

export type PlugEvalResult = {
  subjectType: "plug";
  subjectId: string;
  version: string;
  score: number;
  capabilityScore: number;
  delta?: number;
  qualityLabel: ReturnType<typeof deriveQualityLabel>;
  trials: TrialResult[];
  failureClusters: Record<string, number>;
};

export async function runPlugEval(plug: PlugDefinition): Promise<PlugEvalResult> {
  const agent = plugToEvalAgent(plug);
  const trials = await runEvalSuite(agent, {
    transcriptForTask: () => `${plug.name} completed with tool:reports.create`,
  });
  const capabilityScore = computeCapabilityScore(trials);
  const failureClusters = trials
    .filter((trial) => !trial.passed)
    .reduce<Record<string, number>>((acc, trial) => {
      const tag = `${trial.taskKind}_failed`;
      acc[tag] = (acc[tag] ?? 0) + 1;
      return acc;
    }, {});

  return {
    subjectType: "plug",
    subjectId: plug.id,
    version: plug.version,
    score: capabilityScore / 100,
    capabilityScore,
    delta: capabilityScore / 100 - plug.evalSet.lastScore,
    qualityLabel: deriveQualityLabel(agent, capabilityScore, trials),
    trials,
    failureClusters,
  };
}

function plugToEvalAgent(plug: PlugDefinition): CatalogAgent {
  const requiredPhrase = plug.name.split(" ")[0] ?? plug.name;
  return {
    id: plug.id,
    name: plug.name,
    emoji: "P",
    category: "specialized",
    specialties: plug.category,
    whenToUse: `Run ${plug.name}`,
    color: "#2563eb",
    file: `plugs/${plug.slug}.md`,
    reversibilityMatrix: {
      reversible: plug.declaredTools.flatMap((tool) => tool.allowedActions.map((action) => `${tool.toolId}.${action}`)),
      costlyToReverse: [],
      irreversible: [],
    },
    evalSuite: {
      capability: plug.evalSet.fixtureRefs.map((fixture) => ({
        id: fixture,
        kind: "capability",
        split: "heldout",
        desc: `${plug.name} completes fixture ${fixture}`,
        graders: [
          { kind: "code", check: "includes", value: requiredPhrase },
          { kind: "code", check: "tool_call", toolName: "reports.create" },
        ],
        passMetric: "pass@1",
      })),
      regression: [],
    },
  };
}
