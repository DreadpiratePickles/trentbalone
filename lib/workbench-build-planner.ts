/**
 * workbench-build-planner.ts — the "manager" pass of the multi-agent build.
 *
 * Asks the planner model for a file-level build plan (a DAG of files to write,
 * each with a one-line intent and the in-plan files it depends on), plus the
 * shared decisions (schema, routes, shared types) that every editor needs. The
 * model call is injectable so the planner is unit-testable without a live key.
 */

import { z } from "zod";
import { callJson, MAX_TOKENS, MODELS } from "@/lib/ai-client";
import type { WorkbenchTemplate } from "@/lib/workbench-templates";
import type { BuildPlanFile } from "@/lib/workbench-build-graph";

export type BuildPlan = {
  title: string;
  /** Shared decisions (data model, routes, shared types) given to every editor. */
  decisions: string;
  files: BuildPlanFile[];
};

export const MAX_PLAN_FILES = 40;

const planSchema = z.object({
  title: z.string().min(1).default("Workbench build"),
  decisions: z.string().default(""),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        intent: z.string().min(1),
        dependsOn: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});

/** Matches `callJson` from lib/ai-client; injectable for tests. */
export type PlannerCall = <T>(
  model: string,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  maxTokens: number,
) => Promise<{ data: T }>;

function plannerSystemPrompt(template: WorkbenchTemplate): string {
  return [
    "You are Trent's Workbench build planner (the manager of a team of code-editor agents).",
    `The workspace substrate is: ${template.label} — ${template.summary}`,
    "Decompose the objective into a FILE-LEVEL build plan. Return JSON only:",
    "{ title, decisions, files: [{ path, intent, dependsOn }] }",
    "Rules:",
    "- `files` lists every file to CREATE or EDIT to satisfy the objective, in no particular order.",
    "- `path` is repo-relative and must match the substrate's conventions (e.g. src/app/<route>/page.tsx for full-stack Next.js, src/components/* for the SPA, src/app.ts routes for the API).",
    "- `intent` is a single sentence: what this file must contain/do.",
    "- `dependsOn` lists OTHER paths in THIS plan that the file imports or requires to exist first (e.g. a page depends on the component it renders, a route depends on a shared schema). Do NOT list scaffold files that already exist.",
    "- `decisions` captures shared contracts every file must agree on: the data model / Prisma schema additions, route list, shared TypeScript types, and naming. Keep it tight and concrete.",
    `- Keep the plan focused: at most ${MAX_PLAN_FILES} files. Prefer a few well-factored files over many tiny ones.`,
    "- Do not include install/build/test commands — only files.",
  ].join("\n");
}

function plannerUserPrompt(input: { objective: string; projectContext: string; sourceContext?: string }): string {
  return [
    `Objective: ${input.objective}`,
    input.projectContext ? `Existing project context:\n${input.projectContext}` : "",
    input.sourceContext ? `Company source documents:\n${input.sourceContext}` : "",
    "Produce the file-level build plan as JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function planBuild(input: {
  objective: string;
  template: WorkbenchTemplate;
  projectContext: string;
  sourceContext?: string;
  callPlanner?: PlannerCall;
}): Promise<BuildPlan> {
  const call = (input.callPlanner ?? (callJson as unknown as PlannerCall));
  const { data } = await call(
    MODELS.PLANNER,
    plannerSystemPrompt(input.template),
    plannerUserPrompt(input),
    planSchema,
    MAX_TOKENS.JSON,
  );

  // Defensive: dedupe by path, cap count, drop self-edges.
  const seen = new Set<string>();
  const files: BuildPlanFile[] = [];
  for (const file of data.files) {
    const path = file.path.trim().replace(/^\.\//, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push({
      path,
      intent: file.intent.trim(),
      dependsOn: (file.dependsOn ?? []).map((d) => d.trim().replace(/^\.\//, "")).filter((d) => d && d !== path),
    });
    if (files.length >= MAX_PLAN_FILES) break;
  }

  return {
    title: (data.title ?? "").trim() || "Workbench build",
    decisions: (data.decisions ?? "").trim(),
    files,
  };
}

/** A scoped prompt for one editor: it sees the plan + decisions + only its file's context. */
export function buildEditorPrompt(input: {
  plan: BuildPlan;
  file: BuildPlanFile;
  existingContent?: string;
}): string {
  const { plan, file, existingContent } = input;
  const siblings = plan.files
    .filter((f) => f.path !== file.path)
    .map((f) => `  - ${f.path}: ${f.intent}`)
    .join("\n");
  return [
    `Build title: ${plan.title}`,
    plan.decisions ? `Shared decisions (every file must agree with these):\n${plan.decisions}` : "",
    `Other files in this build (for import/contract awareness — do NOT write them):\n${siblings || "  (none)"}`,
    `Your task: produce the COMPLETE file at \`${file.path}\`.`,
    `Intent: ${file.intent}`,
    existingContent
      ? `This file already exists; here is its current content:\n\`\`\`\n${existingContent.slice(0, 4000)}\n\`\`\``
      : "This is a new file.",
    `Output exactly one <boltArtifact> containing a single <boltAction type="file" filePath="${file.path}"> with the full file content. No other files, no commands, no prose.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
