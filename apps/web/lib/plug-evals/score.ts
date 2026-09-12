import type { CatalogAgent } from "@/lib/agent-catalog";
import type { AgentQualityLabel } from "@/lib/types";
import type { CodeGrader, EvalRunOptions, EvalTask, Grader, TrialResult } from "./types";

export async function runEvalSuite(
  agent: CatalogAgent,
  options: EvalRunOptions = {}
): Promise<TrialResult[]> {
  const tasks = normalizeEvalSuite(agent);
  const trials: TrialResult[] = [];

  for (const task of tasks) {
    const count = task.k ?? 1;
    for (let index = 0; index < count; index += 1) {
      const transcript = await options.transcriptForTask?.(task, agent, index) ?? "";
      const results = await Promise.all(task.graders.map((grader) => evaluateGrader(grader, transcript)));
      const score = weightedAverage(results);
      trials.push({
        taskId: task.id,
        taskKind: task.kind,
        split: task.split ?? "heldout",
        passed: task.partialCredit ? score > 0 : score >= 1,
        score,
        transcriptPath: `memory://plug-evals/${agent.id}/${task.id}/${index}`,
      });
    }
  }

  return trials;
}

export function computeCapabilityScore(trials: TrialResult[]): number {
  const heldOut = trials.filter((trial) => trial.taskKind === "capability" && (trial.split ?? "heldout") === "heldout");
  if (heldOut.length === 0) return 0;
  const score = heldOut.reduce((sum, trial) => sum + clamp01(trial.score), 0) / heldOut.length;
  return Math.round(score * 100);
}

export function deriveQualityLabel(
  agent: CatalogAgent,
  score: number,
  trials: TrialResult[]
): AgentQualityLabel {
  const regressionPassed = trials
    .filter((trial) => trial.taskKind === "regression")
    .every((trial) => trial.passed);

  if (score < 70 || !regressionPassed) return "experimental";
  if (hasRiskyAction(agent)) return "supervised";
  if (score >= 90 && passFiveRate(trials) >= 0.9) return "autonomous";
  return "supervised";
}

export async function evaluateCodeGrader(
  grader: CodeGrader,
  transcript: string,
  state: unknown = {}
): Promise<{ passed: boolean; score: number; weight: number }> {
  const weight = grader.weight ?? 1;
  let passed = false;

  if (grader.check === "includes") {
    passed = transcript.includes(grader.value);
  } else if (grader.check === "regex") {
    passed = new RegExp(grader.pattern, grader.flags).test(transcript);
  } else if (grader.check === "tool_call") {
    passed = transcript.includes(`tool:${grader.toolName}`) || transcript.includes(`"toolName":"${grader.toolName}"`);
  } else {
    passed = readPath(state, grader.path) === grader.equals;
  }

  return { passed, score: passed ? 1 : 0, weight };
}

async function evaluateGrader(
  grader: Grader,
  transcript: string
): Promise<{ passed: boolean; score: number; weight: number }> {
  if (grader.kind === "code") return evaluateCodeGrader(grader, transcript);
  return { passed: false, score: 0, weight: grader.weight ?? 1 };
}

function normalizeEvalSuite(agent: CatalogAgent): EvalTask[] {
  const capability = agent.evalSuite?.capability ?? [];
  const regression = agent.evalSuite?.regression ?? [];
  return [
    ...capability.map((task) => normalizeTask(task, "capability")),
    ...regression.map((task) => normalizeTask(task, "regression")),
  ];
}

function normalizeTask(task: string | EvalTask, kind: EvalTask["kind"]): EvalTask {
  if (typeof task !== "string") return task;
  return {
    id: task,
    kind,
    split: "heldout",
    desc: task,
    graders: [{ kind: "code", check: "includes", value: task }],
    passMetric: "pass@1",
  };
}

function weightedAverage(results: Array<{ score: number; weight: number }>): number {
  if (results.length === 0) return 0;
  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  return results.reduce((sum, result) => sum + clamp01(result.score) * result.weight, 0) / totalWeight;
}

function passFiveRate(trials: TrialResult[]): number {
  const heldOut = trials.filter((trial) => trial.taskKind === "capability" && (trial.split ?? "heldout") === "heldout");
  if (heldOut.length < 5) return 0;
  return heldOut.filter((trial) => trial.passed).length / heldOut.length;
}

function hasRiskyAction(agent: CatalogAgent): boolean {
  const matrix = agent.reversibilityMatrix;
  const irreversible = matrix?.irreversible ?? [];
  const costly = matrix?.costlyToReverse ?? [];
  if (irreversible.length > 0) return true;
  return [...costly, ...irreversible].some((action) =>
    /(ads\.launch|ads\.spend|charge|deploy|gmail\.send|merge|money|payment|payout|production|publish|refund|send)/i.test(action)
  );
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in current) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
