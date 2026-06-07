import type { CallJsonOptions } from "@/lib/ai-client";
import type { executeSeatModel } from "@/lib/model-gateway";
import type { AcceptanceStep, InteractionDriver } from "@/lib/workbench-interaction-verify";
import type { WorkbenchCriticReviewer } from "@/lib/workbench-verify";

export type OrchestrationEvalOverrides = {
  createCompletion?: CallJsonOptions["createCompletion"];
  executeSeatModelFn?: typeof executeSeatModel;
  /** When true, planner mock returns an invalid cyclic plan so integration eval fails. */
  forceBrokenPlanner?: boolean;
  /** When true, step execution throws so integration eval fails. */
  forceBrokenExecution?: boolean;
};

export type WorkbenchEvalOverrides = {
  forceBrokenBuild?: boolean;
  acceptanceSteps?: AcceptanceStep[];
  interactionDriver?: InteractionDriver;
  criticReviewer?: WorkbenchCriticReviewer;
};

export type RuntimeEvalOverrides = {
  orchestration?: OrchestrationEvalOverrides;
  workbench?: WorkbenchEvalOverrides;
};

let activeOverrides: RuntimeEvalOverrides | null = null;

export function setRuntimeEvalOverrides(overrides: RuntimeEvalOverrides | null): void {
  activeOverrides = overrides;
}

export function getRuntimeEvalOverrides(): RuntimeEvalOverrides | null {
  return activeOverrides;
}

export function clearRuntimeEvalOverrides(): void {
  activeOverrides = null;
}
