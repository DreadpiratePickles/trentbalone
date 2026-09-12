/**
 * GEPA — Reflective Prompt Evolution (Phase 4 of the Trent self-improvement loop).
 *
 * GEPA (Genetic-Pareto) is the overnight prompt optimizer from the ICLR 2026
 * paper that underpins Hermes. Rather than collapsing feedback into a scalar
 * reward, it reads actual execution traces in natural language, diagnoses
 * failures, proposes targeted prompt edits, and keeps a small diverse Pareto
 * set of top-performing candidates per role.
 *
 * Trent's implementation:
 *   1. Pick the worst-scoring agent role from recent traces.
 *   2. Gather failing traces for that role (critic improvements = reflection signal).
 *   3. Ask an LLM to reflect and propose a targeted system-prompt edit.
 *   4. Score the proposed prompt candidate against the frozen eval suite (Eval Gate).
 *   5. Update the Pareto frontier — keep ≤ N diverse candidates per role.
 *
 * Overnight-only: runs inside the heartbeat's self-improvement sweep, fully
 * within existing per-agent token budgets and spend caps.
 *
 * See docs/superpowers/plans/2026-06-02-self-improvement-loop-plan.md Phase 4.
 */

import { makeId, nowIso } from "@/lib/utils";
import type { TraceRecord } from "@/lib/trace-store";
import type { AgentRole } from "@/lib/types";
import { promoteCandidate, type EvalGateBaseline, type EvalGateDecision } from "@/lib/eval-gate";
import type { EvalSuiteInput } from "@/lib/eval-harness";

// Previously defaulted to "claude-sonnet-4-5" which was passed to the OpenAI
// client and always failed silently. Fixed to a valid GPT-4 model name.
import { MODELS, MAX_TOKENS, createAIClient } from "@/lib/ai-client";
const GEPA_REFLECT_MODEL = process.env.GEPA_MODEL ?? MODELS.DEFAULT;
const GEPA_DEFAULT_FRONTIER_SIZE = 5;

export type GEPACandidate = {
  id: string;
  roleId: AgentRole;
  proposedPrompt: string;
  /** Natural-language rationale produced by the reflection step. */
  reflectionRationale: string;
  /** Eval-gate score on the frozen suite (0..1). */
  score: number;
  /** Delta vs the baseline at the time of evaluation. */
  delta: number;
  /** Failure clusters from the eval result — used for Pareto diversity. */
  failureClusters: Record<string, number>;
  createdAt: string;
};

/** A small diverse set of top-performing prompt candidates for one agent role. */
export type GEPAFrontier = {
  roleId: AgentRole;
  /** Best candidate to use as the current prompt (highest score). */
  best: GEPACandidate | null;
  /** Full Pareto set — diverse across failure cluster profiles. */
  candidates: GEPACandidate[];
  updatedAt: string;
};

export type ReflectionProposal = {
  rationale: string;
  proposedPrompt: string;
};

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Build the reflection prompt that asks the LLM to diagnose failing traces and
 * propose a targeted edit to the agent's system prompt.
 */
export function buildReflectionPrompt(
  role: AgentRole,
  currentPrompt: string,
  failingTraces: readonly TraceRecord[],
): string {
  const traceSummary = failingTraces
    .slice(0, 20) // cap tokens
    .map(
      (t, i) =>
        `Trace ${i + 1}: step="${t.stepTitle}" verdict=${t.critiqueVerdict ?? "none"}` +
        (t.improvement ? ` improvement_note="${t.improvement}"` : "") +
        (t.toolCalls.length ? ` tools=[${t.toolCalls.join(", ")}]` : ""),
    )
    .join("\n");

  return [
    `You are a prompt engineer reviewing failures of the "${role}" agent in Trent.`,
    "Your task: read the failing traces, diagnose the root cause, and propose ONE targeted edit",
    "to the agent's system prompt that would prevent these failures.",
    "",
    "Rules:",
    "  - Change as little as possible — a one-sentence addition is better than a full rewrite.",
    "  - Address the most common failure pattern, not every edge case.",
    "  - The proposed prompt must be the full new system prompt (it replaces the current one).",
    "",
    `Current system prompt for role "${role}":`,
    currentPrompt,
    "",
    "Failing traces:",
    traceSummary,
    "",
    'Respond with JSON: { "rationale": "...", "proposed_prompt": "..." }',
    "rationale: 1–2 sentences explaining what you changed and why.",
    "proposed_prompt: the full revised system prompt.",
  ].join("\n");
}

/**
 * Parse the LLM's reflection JSON into a ReflectionProposal.
 * Falls back to the current prompt unchanged on parse failure.
 */
export function parseReflectionResponse(raw: string, fallbackPrompt: string): ReflectionProposal {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const json = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    if (json.proposed_prompt && json.rationale) {
      return {
        rationale: String(json.rationale),
        proposedPrompt: String(json.proposed_prompt),
      };
    }
  } catch {
    // fall through
  }
  return {
    rationale: "LLM reflection failed — prompt unchanged.",
    proposedPrompt: fallbackPrompt,
  };
}

/**
 * Add a new candidate to the Pareto frontier, maintaining:
 *   - At most `maxSize` candidates.
 *   - Diversity: prefer keeping one candidate per distinct failure-cluster profile.
 *   - Quality: among candidates with the same cluster profile, keep the highest scorer.
 *
 * Returns the updated frontier (immutable — does not mutate input).
 */
export function updateParetoFrontier(
  frontier: GEPAFrontier,
  incoming: GEPACandidate,
  maxSize = GEPA_DEFAULT_FRONTIER_SIZE,
): GEPAFrontier {
  const clusterKey = (c: GEPACandidate) =>
    Object.keys(c.failureClusters).sort().join("|") || "clean";

  const existing = [...frontier.candidates];
  const inKey = clusterKey(incoming);

  // Replace a worse candidate with the same cluster profile (patch rather than grow)
  const sameProfileIdx = existing.findIndex((c) => clusterKey(c) === inKey);
  if (sameProfileIdx >= 0) {
    if (incoming.score > existing[sameProfileIdx].score) {
      existing[sameProfileIdx] = incoming;
    }
  } else {
    existing.push(incoming);
  }

  // If over capacity, drop the lowest scorer
  const trimmed =
    existing.length > maxSize
      ? existing.sort((a, b) => b.score - a.score).slice(0, maxSize)
      : existing;

  const best = trimmed.reduce<GEPACandidate | null>(
    (acc, c) => (acc === null || c.score > acc.score ? c : acc),
    null,
  );

  return {
    ...frontier,
    candidates: trimmed,
    best,
    updatedAt: nowIso(),
  };
}

/**
 * Pick the agent role with the worst average eval score from a set of traces.
 * Returns null when traces is empty.
 */
export function worstPerformingRole(traces: readonly TraceRecord[]): AgentRole | null {
  if (traces.length === 0) return null;
  const byRole = new Map<AgentRole, number[]>();
  for (const t of traces) {
    if (t.evalScore !== undefined) {
      byRole.set(t.agentRole, [...(byRole.get(t.agentRole) ?? []), t.evalScore]);
    }
  }
  if (byRole.size === 0) return null;
  let worst: AgentRole | null = null;
  let worstAvg = Infinity;
  for (const [role, scores] of byRole) {
    const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    if (avg < worstAvg) { worstAvg = avg; worst = role; }
  }
  return worst;
}

// ─── LLM call ────────────────────────────────────────────────────────────────

async function callReflectionLLM(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "";
  try {
    const completion = await createAIClient().chat.completions.create({
      model:       GEPA_REFLECT_MODEL,
      temperature: 0.3,
      max_tokens:  MAX_TOKENS.JSON,
      messages:    [{ role: "user", content: prompt }],
    });
    return completion.choices[0]?.message.content?.trim() ?? "";
  } catch (err) {
    console.error("gepa.reflect_failed", { model: GEPA_REFLECT_MODEL, error: err instanceof Error ? err.message : String(err) });
    return "";
  }
}

// ─── Main evolution pass ──────────────────────────────────────────────────────

export type EvolveOptions = {
  /** Skip the LLM and return a trivially modified prompt. Useful for tests. */
  skipLLM?: boolean;
  maxFrontierSize?: number;
  id?: string;
  now?: string;
};

/**
 * Run one GEPA evolution pass for a given role:
 *   1. Build the reflection prompt from failing traces.
 *   2. Call the LLM (or skip in test mode).
 *   3. Score the proposed prompt against the frozen eval suite.
 *   4. Update and return the frontier.
 *
 * Returns null when there are no failing traces to reflect on.
 */
export async function evolveRolePrompt(
  roleId: AgentRole,
  currentPrompt: string,
  failingTraces: readonly TraceRecord[],
  frozenSuite: Omit<EvalSuiteInput, "subjectId" | "previousScore">,
  baseline: EvalGateBaseline,
  frontier: GEPAFrontier,
  options: EvolveOptions = {},
): Promise<{ frontier: GEPAFrontier; decision: EvalGateDecision } | null> {
  if (failingTraces.length === 0) return null;

  const now = options.now ?? nowIso();
  const candidateId = options.id ?? makeId("gepa");

  let proposal: ReflectionProposal;
  if (options.skipLLM) {
    proposal = {
      rationale: "Test mode — minimal prompt change.",
      proposedPrompt: currentPrompt + "\n<!-- gepa evolved -->",
    };
  } else {
    const reflectionPrompt = buildReflectionPrompt(roleId, currentPrompt, failingTraces);
    const raw = await callReflectionLLM(reflectionPrompt);
    proposal = parseReflectionResponse(raw, currentPrompt);
  }

  const decision = await promoteCandidate(
    { id: candidateId, type: "prompt", version: "1.0.0" },
    frozenSuite,
    baseline,
  );

  const candidate: GEPACandidate = {
    id: candidateId,
    roleId,
    proposedPrompt: proposal.proposedPrompt,
    reflectionRationale: proposal.rationale,
    score: decision.score,
    delta: decision.delta,
    failureClusters: decision.result.failureClusters,
    createdAt: now,
  };

  const updatedFrontier = updateParetoFrontier(
    frontier,
    candidate,
    options.maxFrontierSize ?? GEPA_DEFAULT_FRONTIER_SIZE,
  );

  return { frontier: updatedFrontier, decision };
}

/** Create an empty frontier for a role. */
export function emptyFrontier(roleId: AgentRole, now?: string): GEPAFrontier {
  return { roleId, best: null, candidates: [], updatedAt: now ?? nowIso() };
}
