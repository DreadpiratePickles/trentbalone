/**
 * lib/planner-model.ts — §1 P1-1: model-based task decomposition that emits the
 * existing typed Subtask contracts.
 *
 * Engine C's decomposition (lib/planner.ts) is deterministic: a regex
 * `classifyTask`, a keyword `selectPlannerSeats`, and template objectives
 * (`"${seat} contribution for: ${prompt}"`). The audit (cursor-trent-next-level
 * master plan, §1 P1-1) calls for replacing that with a planner-model call that
 * produces specific, effort-scaled subtasks while keeping the keyword table as
 * the zero-key / parse-failure fallback.
 *
 * Research grounding (Anthropic multi-agent research system): vague delegation is
 * the #1 documented multi-agent failure (duplicate work, gaps); effort must be
 * scaled to complexity — 1 seat for trivial work, 2–4 for standard, a small swarm
 * only where work is genuinely parallel. Every subtask needs a concrete objective,
 * output format, tool guidance, and boundaries.
 *
 * SAFETY: this is gated behind PLANNER_MODEL_ENABLED (default OFF). When the flag
 * is off, no API key is present, or the model output cannot be validated, this
 * returns `null` and the caller (`plan()`) uses the unchanged deterministic path —
 * so behaviour degrades safely, never silently wrong, and production decomposition
 * is identical until the flag is explicitly turned on.
 */
import { z } from "zod";
import type { AgentRole } from "@/lib/types";
import type { TaskClassification } from "@/lib/planner";
import { callJsonWithRepair } from "@/lib/llm-json";
import { MODELS, MAX_TOKENS } from "@/lib/ai-client";
import { logger } from "@/lib/logger";
import { seatOutputSchemas } from "@/lib/seat-output-schemas";

/** Canonical seat universe, derived from the output-contract registry so this
 * stays in lock-step with the seats that actually have a validated contract. */
const VALID_SEATS = Object.keys(seatOutputSchemas) as AgentRole[];

const MIN_BUDGET_CENTS = 10;
const MAX_BUDGET_CENTS = 100;
const MAX_SUBTASKS = 9;

/** A validated, deduped subtask spec the model produced. The caller maps each
 * one into the full `subtaskSchema` (id, contract id, context bundle, input). */
export interface ModeledSubtaskSpec {
  seat: AgentRole;
  objective: string;
  toolGuidance: string[];
  boundaries: string[];
  budgetCents: number;
}

export function isPlannerModelEnabled(): boolean {
  const v = process.env.PLANNER_MODEL_ENABLED;
  return v === "1" || v === "true";
}

function clampBudget(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 50;
  return Math.min(MAX_BUDGET_CENTS, Math.max(MIN_BUDGET_CENTS, Math.round(n)));
}

/** Raw model output — intentionally permissive on `seat` (string) so a
 * hallucinated seat name fails our allow-list check instead of the whole call. */
const modelOutputSchema = z.object({
  subtasks: z
    .array(
      z.object({
        seat: z.string(),
        objective: z.string().min(8),
        toolGuidance: z.array(z.string()).default([]),
        boundaries: z.array(z.string()).default([]),
        budgetCents: z.number().optional(),
      }),
    )
    .min(1)
    .max(MAX_SUBTASKS),
});

function effortHint(c: TaskClassification): string {
  if (c.complexity === "trivial") return "TRIVIAL: emit exactly 1 seat. Do not fan out.";
  if (c.complexity === "complex")
    return "COMPLEX: up to 5 seats, only where each has genuinely parallel, non-overlapping work. Never duplicate scope.";
  return "STANDARD: 2–4 seats. Prefer fewer; only add a seat that has a concrete, distinct deliverable.";
}

/**
 * Decompose one request into validated subtask specs using the planner model.
 * Returns `null` (caller falls back to the deterministic planner) when the flag
 * is off, no API key is configured, or the output cannot be validated.
 */
export async function modelDecompose(input: {
  prompt: string;
  classification: TaskClassification;
  /** Optional compact operating-state text (OperatingStateBundle.text). */
  context?: string;
}): Promise<ModeledSubtaskSpec[] | null> {
  if (!isPlannerModelEnabled()) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const system = [
    "You are Trent's CEO-orchestrator. Decompose ONE operating request into typed subtasks for specialist seats.",
    `Available seats: ${VALID_SEATS.join(", ")}.`,
    "Every subtask MUST have a concrete, verifiable deliverable. Vague delegation is the #1 multi-agent failure (duplicate work, gaps).",
    "Scale effort to complexity — do not over-spawn.",
    "Any irreversible/external action (send, publish, charge, deploy, merge, delete) must include the 'escalation' seat to prepare an approval card; all other seats DRAFT ONLY.",
    "Each subtask fields: seat, objective (specific + measurable), toolGuidance[], boundaries[], budgetCents (10–100).",
  ].join("\n");

  const user = [
    `REQUEST:\n${input.prompt}`,
    "",
    `CLASSIFICATION: complexity=${input.classification.complexity}, reversibility=${input.classification.reversibility}`,
    `EFFORT: ${effortHint(input.classification)}`,
    input.context ? `\nCURRENT OPERATING STATE:\n${input.context.slice(0, 1800)}` : "",
    "",
    'Return ONLY JSON: { "subtasks": [ { "seat", "objective", "toolGuidance", "boundaries", "budgetCents" } ] }.',
    "Use only the listed seat names.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { data } = await callJsonWithRepair<z.infer<typeof modelOutputSchema>>({
      model: MODELS.STRONG,
      system,
      user,
      schema: modelOutputSchema,
      maxTokens: MAX_TOKENS.PLANNING,
    });

    const seen = new Set<AgentRole>();
    const specs: ModeledSubtaskSpec[] = [];
    for (const raw of data.subtasks) {
      const seat = raw.seat as AgentRole;
      if (!VALID_SEATS.includes(seat)) continue; // drop hallucinated seats
      if (seen.has(seat)) continue; // one subtask per seat — dedupe scope (anti-overlap)
      seen.add(seat);
      specs.push({
        seat,
        objective: raw.objective.trim(),
        toolGuidance: raw.toolGuidance ?? [],
        boundaries: raw.boundaries ?? [],
        budgetCents: clampBudget(raw.budgetCents),
      });
    }

    if (specs.length === 0) return null;

    // Safety net: irreversible work always routes an escalation/approval seat,
    // even if the model omitted it.
    if (input.classification.reversibility === "irreversible" && !seen.has("escalation")) {
      specs.push({
        seat: "escalation",
        objective: `Prepare an approval card for the irreversible action in: ${input.prompt}`,
        toolGuidance: ["prepare approval card; do not execute external action"],
        boundaries: ["irreversible action requires human approval"],
        budgetCents: 20,
      });
    }

    logger.info({ count: specs.length, seats: specs.map((s) => s.seat) }, "[planner-model] model-based subtasks");
    return specs;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[planner-model] decompose failed; falling back to deterministic planner",
    );
    return null;
  }
}
