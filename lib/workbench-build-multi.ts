/**
 * workbench-build-multi.ts — composes the multi-agent build:
 *   planner (manager) → dependency waves → parallel scoped editors.
 *
 * This is the orchestration seam the build loop calls when an objective is
 * large/complex enough to benefit from parallel file-level editing. Both model
 * touchpoints (`callPlanner`, `editFile`) are injected, so the whole flow is
 * unit-testable with fakes and has no hard dependency on a live LLM key here.
 */

import { planBuild, type BuildPlan, type PlannerCall } from "@/lib/workbench-build-planner";
import { planToWaves, type BuildPlanFile, type BuildWaves } from "@/lib/workbench-build-graph";
import { runEditorWaves, type EditorResult } from "@/lib/workbench-build-editors";
import type { WorkbenchTemplate } from "@/lib/workbench-templates";

export type PlannedBuildResult = {
  plan: BuildPlan;
  waves: BuildWaves;
  results: EditorResult[];
  written: string[];
  failed: EditorResult[];
  aborted: boolean;
};

/** Minimum plan size before the multi-agent path is worthwhile vs one artifact. */
export const MULTI_AGENT_MIN_FILES = 6;

export async function runPlannedBuild(input: {
  objective: string;
  template: WorkbenchTemplate;
  projectContext: string;
  sourceContext?: string;
  callPlanner?: PlannerCall;
  editFile: (file: BuildPlanFile) => Promise<EditorResult>;
  concurrency?: number;
  maxFailures?: number;
  onPlan?: (plan: BuildPlan, waves: BuildWaves) => void;
  onResult?: (result: EditorResult, waveIndex: number) => void;
}): Promise<PlannedBuildResult> {
  const plan = await planBuild({
    objective: input.objective,
    template: input.template,
    projectContext: input.projectContext,
    sourceContext: input.sourceContext,
    callPlanner: input.callPlanner,
  });

  const waves = planToWaves(plan.files);
  input.onPlan?.(plan, waves);

  const { results, aborted } = await runEditorWaves({
    waves: waves.waves,
    files: plan.files,
    editFile: input.editFile,
    concurrency: input.concurrency,
    maxFailures: input.maxFailures,
    onResult: input.onResult,
  });

  const written = results.filter((r) => r.ok).map((r) => r.path);
  const failed = results.filter((r) => !r.ok);

  return { plan, waves, results, written, failed, aborted };
}

/** Heuristic: is this objective worth the multi-agent path? */
export function shouldUseMultiAgentPlan(fileCount: number): boolean {
  return fileCount >= MULTI_AGENT_MIN_FILES;
}
