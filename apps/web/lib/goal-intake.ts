/**
 * lib/goal-intake.ts — §2 Slice 1: CEO intake.
 *
 * Turns a founder's natural-language command into a refined objective plus
 * measurable success criteria and a budget estimate. Uses the CEO model with a
 * repair retry (no silent fallback). The founder approves/edits the criteria at
 * HUMAN GATE #1 before any round runs (a competing platform Plan Mode).
 */
import { getAgentRuntime } from "@/lib/agent-runtime";
import { MODELS } from "@/lib/ai-client";
import { callJsonWithRepair } from "@/lib/llm-json";
import { goalIntakeSchema, type GoalIntake } from "@/lib/goal-types";
import type { Company } from "@/lib/types";

export async function runGoalIntake(company: Company, command: string): Promise<GoalIntake> {
  const ceoRuntime = await getAgentRuntime(company.id, "ceo").catch(() => null);
  const system = [
    ceoRuntime?.systemPrompt ?? "You are the CEO of an autonomous AI operating company.",
    "",
    "You are running GOAL INTAKE. The founder gave you a command. Convert it into:",
    "  1. A crisp one-sentence objective.",
    "  2. 3–6 MEASURABLE success criteria — each independently verifiable with a concrete artifact (a document, a built feature, a research memo). Avoid vague criteria like 'improve growth'; prefer 'a 3-channel growth experiment plan with target metrics exists'.",
    "  3. A budget estimate in cents for the whole goal (rounds included).",
    "Respond as JSON: { objective, successCriteria: [{text}], budgetEstimateCents, rationale }.",
  ].join("\n");

  const user = [
    `Company: ${company.name}`,
    `Brief — vision: ${company.brief?.vision ?? "n/a"}; ICP: ${company.brief?.icp ?? "n/a"}; offer: ${company.brief?.offer ?? "n/a"}; goals: ${company.brief?.goals ?? "n/a"}.`,
    "",
    `Founder command: "${command}"`,
  ].join("\n");

  const { data } = await callJsonWithRepair<GoalIntake>({
    model: MODELS.STRONG,
    system,
    user,
    schema: goalIntakeSchema,
  });
  return data;
}
