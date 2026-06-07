import type { CatalogAgent } from "@/lib/agent-catalog";
import type { AgentQualityLabel } from "@/lib/types";

export type GraderKind = "code" | "llm_rubric" | "human";

export type CodeGrader =
  | { kind: "code"; check: "includes"; value: string; weight?: number }
  | { kind: "code"; check: "regex"; pattern: string; flags?: string; weight?: number }
  | { kind: "code"; check: "tool_call"; toolName: string; weight?: number }
  | { kind: "code"; check: "state"; path: string; equals: unknown; weight?: number };

export type LlmRubricGrader = {
  kind: "llm_rubric";
  rubric: string;
  weight?: number;
};

export type HumanGrader = {
  kind: "human";
  rubric: string;
  weight?: number;
};

export type Grader = CodeGrader | LlmRubricGrader | HumanGrader;

export type EvalTask = {
  id: string;
  kind: "capability" | "regression";
  split?: "train" | "heldout";
  desc: string;
  graders: Grader[];
  referenceSolutionPath?: string;
  passMetric: "pass@1" | "pass@k" | "pass^k";
  k?: number;
  partialCredit?: boolean;
};

export type TrialResult = {
  taskId: string;
  taskKind: EvalTask["kind"];
  split?: EvalTask["split"];
  passed: boolean;
  score: number;
  transcriptPath: string;
};

export type CapabilityResult = {
  score: number | null;
  qualityLabel: AgentQualityLabel;
  trials: TrialResult[];
};

export type EvalRunOptions = {
  transcriptForTask?: (task: EvalTask, agent: CatalogAgent, trialIndex: number) => string | Promise<string>;
};
