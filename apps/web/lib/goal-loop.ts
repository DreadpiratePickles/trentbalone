/**
 * lib/goal-loop.ts — §2 The Goal Loop core.
 *
 * runGoalRound(goalId):
 *   PLAN     — planner model sees the goal + criteria ledger (unmet first) + the
 *              OperatingStateBundle (§1) + recalled memory, and emits typed,
 *              effort-scaled tasks with dependsOn + outputContractId + boundaries.
 *   EXECUTE  — DAG pool (concurrency-capped) runs each task through the same
 *              runtime cycles use; every step MUST yield a persisted typed
 *              artifact (artifact-first — no prose passes).
 *   CRITIC   — per artifact, evidence-based (artifact body + targeted criterion).
 *   REVIEW   — CEO maps accepted artifacts → criteria, flips criteria to met ONLY
 *              with evidenceArtifactIds, writes the round summary + criteriaDelta,
 *              and proposes the next round.
 *
 * Scope isolation: each step's context is its own subtask + only the upstream
 * artifacts it depends on (resolved by executeStepWithRuntime via dependsOn) —
 * never the whole goal history. The round review compacts everything back into
 * the Goal, which is the external memory.
 */
import { z } from "zod";
import { store } from "@/lib/store";
import { db } from "@/lib/db";
import { makeId, nowIso } from "@/lib/utils";
import { MODELS } from "@/lib/ai-client";
import { callJsonWithRepair, LlmJsonError } from "@/lib/llm-json";
import { getOrcMaxConcurrency } from "@/lib/orchestrator";
import { executeStepWithRuntime, type RuntimeStep } from "@/lib/orchestrator-runtime";
import { buildOperatingStateBundle } from "@/lib/operating-state";
import { emitJobEvent } from "@/lib/job-events";
import { contextLogger } from "@/lib/logger";
import {
  getGoal,
  updateGoal,
  addGoalRound,
  appendGoalProgress,
} from "@/lib/goal-store";
import {
  goalRoundPlanSchema,
  goalReviewSchema,
  type Goal,
  type GoalRoundPlan,
  type GoalTask,
  type GoalReview,
  type SuccessCriterion,
  type CriteriaDelta,
} from "@/lib/goal-types";
import type { AgentRole, ArtifactType, Company } from "@/lib/types";
import { deriveSkillDraftsFromGoalRound } from "@/lib/self-improvement/goal-reflection";

const ROLE_ARTIFACT_TYPE: Record<AgentRole, ArtifactType> = {
  ceo: "operating_memo",
  engineer: "operating_memo",
  growth: "campaign_report",
  content: "operating_memo",
  support: "support_summary",
  finance: "xlsx_report",
  analyst: "competitive_research",
  escalation: "operating_memo",
  sales: "operating_memo",
};

const SEATS: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];

export type GoalRoundResult = {
  goalId: string;
  roundN: number;
  runId: string;
  artifactIds: string[];
  costCents: number;
  status: Goal["status"];
  summary: string;
  criteriaDelta: CriteriaDelta[];
};

// ── Planning ──────────────────────────────────────────────────────────────────

function keywordFallbackPlan(goal: Goal): GoalRoundPlan {
  const unmet = goal.successCriteria.filter((c) => c.status !== "met");
  const tasks: GoalTask[] = (unmet.length ? unmet : goal.successCriteria.slice(0, 1)).slice(0, 4).map((criterion) => {
    const lower = `${goal.objective} ${criterion.text}`.toLowerCase();
    const seat: AgentRole =
      /(code|build|ship|feature|app|api|bug|deploy)/.test(lower) ? "engineer" :
      /(growth|campaign|acquisition|ad|seo|funnel)/.test(lower) ? "growth" :
      /(content|copy|post|email|blog)/.test(lower) ? "content" :
      /(sales|lead|pipeline|outreach|prospect)/.test(lower) ? "sales" :
      /(finance|budget|revenue|spend|cost)/.test(lower) ? "finance" :
      /(support|ticket|customer)/.test(lower) ? "support" :
      "analyst";
    return {
      id: makeId("gtask"),
      seat,
      objective: `Produce the artifact that satisfies: ${criterion.text}`,
      outputContractId: `${seat}.v1`,
      toolGuidance: [],
      boundaries: ["no external side effects without approval"],
      dependsOn: [],
      targetsCriteriaIds: [criterion.id],
      riskLevel: "low",
      budgetCents: 50,
    };
  });
  return { reasoning: "keyword fallback plan (planner model unavailable)", effort: "standard", tasks };
}

export async function planGoalRound(
  company: Company,
  goal: Goal,
): Promise<{ plan: GoalRoundPlan; degraded: boolean; stateText: string }> {
  const bundle = await buildOperatingStateBundle(company, goal.objective);
  const unmet = goal.successCriteria.filter((c) => c.status !== "met");
  const met = goal.successCriteria.filter((c) => c.status === "met");
  const lastRound = goal.rounds[goal.rounds.length - 1];

  const system = [
    "You are Trent's orchestrator-planner. You decompose a GOAL into a round of typed tasks.",
    "Rules (Anthropic multi-agent guidance):",
    "  - Plan ONLY for UNMET criteria, unmet criteria first.",
    "  - Scale effort to complexity: trivial → 1 task, standard → 2–4, complex → up to ~8. Never spawn a seat without a concrete deliverable.",
    "  - Every task needs a SPECIFIC, output-shaped objective (never 'engineer contribution for X'), the seat that owns it, dependsOn (ids of earlier tasks in THIS plan), the criteria ids it targets, toolGuidance, boundaries, riskLevel, and a cent budget.",
    `  - Available seats: ${SEATS.join(", ")}.`,
    "  - outputContractId should be '<seat>.v1'.",
    "Respond as JSON: { reasoning, effort: 'trivial'|'standard'|'complex', tasks: [{ id, seat, objective, outputContractId, toolGuidance[], boundaries[], dependsOn[], targetsCriteriaIds[], riskLevel, budgetCents }] }.",
    "Generate task ids yourself as short slugs (e.g. 't1','t2') and reference them in dependsOn.",
  ].join("\n");

  const user = [
    `GOAL: ${goal.objective}`,
    "",
    "UNMET CRITERIA:",
    ...unmet.map((c) => `- (${c.id}) ${c.text}`),
    met.length ? `\nALREADY MET (do not replan): ${met.map((c) => c.text).join("; ")}` : "",
    lastRound ? `\nLAST ROUND REVIEW: ${lastRound.summary}` : "",
    "",
    "OPERATING STATE:",
    bundle.text,
    "",
    `Budget remaining for this goal: $${(Math.max(0, goal.constraints.budgetCentsCap - goal.costCents) / 100).toFixed(2)}.`,
  ].filter(Boolean).join("\n");

  try {
    const { data } = await callJsonWithRepair<GoalRoundPlan>({
      model: MODELS.STRONG,
      system,
      user,
      schema: goalRoundPlanSchema,
    });
    // Normalise ids: ensure unique, stable ids the executor can map dependsOn against.
    const idMap = new Map<string, string>();
    for (const t of data.tasks) {
      const realId = makeId("gtask");
      idMap.set(t.id, realId);
      t.id = realId;
    }
    for (const t of data.tasks) {
      t.dependsOn = (t.dependsOn ?? []).map((d) => idMap.get(d) ?? d).filter((d) => idMap.has(d) || data.tasks.some((x) => x.id === d));
      if (!SEATS.includes(t.seat)) t.seat = "analyst";
    }
    return { plan: data, degraded: false, stateText: bundle.text };
  } catch (err) {
    if (!(err instanceof LlmJsonError)) throw err;
    return { plan: keywordFallbackPlan(goal), degraded: true, stateText: bundle.text };
  }
}

// ── Execution (DAG pool) ──────────────────────────────────────────────────────

type ExecutedStep = {
  task: GoalTask;
  output: string;
  artifactId: string | null;
  costCents: number;
  ok: boolean;
};

async function persistArtifactForStep(
  company: Company,
  goal: Goal,
  task: GoalTask,
  output: string,
  roundN: number,
): Promise<string | null> {
  if (!output || output.trim().length < 12) return null; // contract-invalid: no prose-less / empty passes
  const type = ROLE_ARTIFACT_TYPE[task.seat] ?? "operating_memo";
  const title = `${task.seat} · round ${roundN} · ${task.objective.slice(0, 64)}`;
  const artifact = await store.createArtifact({
    companyId: company.id,
    type,
    status: "ready",
    title,
    summary: task.objective,
    content: output,
    exportFormat: "markdown",
    createdByAgent: task.seat,
    provenance: {
      prompt: task.objective,
      sources: [`goal:${goal.id}`, `round:${roundN}`, ...task.targetsCriteriaIds.map((c) => `criterion:${c}`)],
      model: MODELS.DEFAULT,
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  }).catch(() => null);
  return artifact?.id ?? null;
}

async function executeRoundDag(
  company: Company,
  goal: Goal,
  plan: GoalRoundPlan,
  roundN: number,
  runId: string,
): Promise<ExecutedStep[]> {
  const concurrency = getOrcMaxConcurrency();
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const done = new Map<string, ExecutedStep>();
  const previousOutputs: Record<string, string> = {};
  const remaining = new Set(plan.tasks.map((t) => t.id));

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const t = byId.get(id)!;
      return (t.dependsOn ?? []).every((d) => !remaining.has(d));
    });
    if (ready.length === 0) {
      // Dependency cycle or dangling dep — run the rest ignoring deps to avoid a stall.
      ready.push(...remaining);
    }
    const batch = ready.slice(0, concurrency);
    const results = await Promise.all(
      batch.map(async (id) => {
        const task = byId.get(id)!;
        const step: RuntimeStep = {
          id: task.id,
          title: task.objective.slice(0, 90),
          agentRole: task.seat,
          rationale: `Goal "${goal.objective}". Targets criteria: ${task.targetsCriteriaIds.join(", ") || "n/a"}.`,
          expectedOutput: task.objective,
          riskLevel: task.riskLevel,
          dependsOn: task.dependsOn ?? [],
          needsApproval: task.riskLevel === "high",
        };
        emitJobEvent({
          jobRunId: runId,
          companyId: company.id,
          status: "step",
          summary: `${task.seat}: ${task.objective.slice(0, 80)}`,
          at: nowIso(),
          step: { phase: "agent_start", role: task.seat, label: task.objective.slice(0, 80) },
        });
        let output = "";
        let costCents = 0;
        let ok = false;
        try {
          const exec = await executeStepWithRuntime({
            step,
            company,
            previousOutputs,
            cycleId: goal.id,
            objective: goal.objective,
          });
          output = exec.output ?? "";
          costCents = exec.costCents ?? 0;
          ok = exec.execution.status !== "failed";
        } catch (e) {
          output = "";
          ok = false;
        }
        const artifactId = ok ? await persistArtifactForStep(company, goal, task, output, roundN) : null;
        const executed: ExecutedStep = { task, output, artifactId, costCents, ok: ok && Boolean(artifactId) };
        emitJobEvent({
          jobRunId: runId,
          companyId: company.id,
          status: "step",
          summary: `${task.seat} ${executed.ok ? "produced artifact" : "failed"}: ${task.objective.slice(0, 60)}`,
          at: nowIso(),
          step: { phase: "agent_end", role: task.seat, label: task.objective.slice(0, 60), costCents },
        });
        return executed;
      }),
    );
    for (const r of results) {
      done.set(r.task.id, r);
      previousOutputs[r.task.id] = r.output.slice(0, 1500);
      remaining.delete(r.task.id);
    }
  }

  return plan.tasks.map((t) => done.get(t.id)!).filter(Boolean);
}

// ── Evidence-based critic ─────────────────────────────────────────────────────

const critiqueSchema = z.object({
  verdict: z.enum(["pass", "retry", "replan", "escalate"]),
  reason: z.string(),
});

async function critiqueArtifact(
  goal: Goal,
  task: GoalTask,
  output: string,
): Promise<{ verdict: string; reason: string }> {
  const targeted = goal.successCriteria.filter((c) => task.targetsCriteriaIds.includes(c.id));
  const system = [
    "You are Trent's quality supervisor. Judge an agent's ARTIFACT against the success criterion it targets — judge what it MADE, with evidence, not what it claims.",
    "Return JSON: { verdict: 'pass'|'retry'|'replan'|'escalate', reason }.",
    "'pass' only if the artifact is concrete and materially advances the targeted criterion.",
  ].join("\n");
  const user = [
    `GOAL: ${goal.objective}`,
    `TARGETED CRITERIA: ${targeted.map((c) => c.text).join("; ") || "(general)"}`,
    `SEAT: ${task.seat}`,
    "",
    `ARTIFACT BODY:\n${output.slice(0, 2400)}`,
  ].join("\n");
  try {
    const { data } = await callJsonWithRepair<{ verdict: string; reason: string }>({
      model: MODELS.CRITIC,
      system,
      user,
      schema: critiqueSchema,
    });
    return data;
  } catch {
    return { verdict: "pass", reason: "critic offline — auto-pass" };
  }
}

// ── CEO round review ──────────────────────────────────────────────────────────

export async function reviewGoalProgress(
  company: Company,
  goal: Goal,
  executed: ExecutedStep[],
  critiques: Record<string, { verdict: string; reason: string }>,
): Promise<GoalReview> {
  const accepted = executed.filter((e) => e.ok && critiques[e.task.id]?.verdict === "pass");
  const system = [
    "You are the CEO doing a GOAL REVIEW. Map accepted artifacts to success criteria.",
    "Flip a criterion to 'met' ONLY if an accepted artifact provides real evidence for it — and cite its artifactId in evidenceArtifactIds.",
    "Use 'blocked' when a criterion cannot progress without the founder. Otherwise keep 'unmet'.",
    "Then propose the next round's tasks (specific, gap-targeted) for criteria still unmet.",
    "Respond as JSON: { summary, criteriaUpdates: [{criterionId, status, evidenceArtifactIds[], reason}], allCriteriaMet, nextRoundProposal: [{seat, objective, targetsCriteriaIds[]}] }.",
  ].join("\n");
  const user = [
    `GOAL: ${goal.objective}`,
    "",
    "SUCCESS CRITERIA:",
    ...goal.successCriteria.map((c) => `- (${c.id}) [${c.status}] ${c.text}`),
    "",
    "ACCEPTED ARTIFACTS THIS ROUND:",
    ...accepted.map((e) => `- artifactId=${e.artifactId} seat=${e.task.seat} targets=${e.task.targetsCriteriaIds.join(",")}\n  ${e.output.slice(0, 400)}`),
    accepted.length === 0 ? "- none accepted this round" : "",
  ].filter(Boolean).join("\n");

  try {
    const { data } = await callJsonWithRepair<GoalReview>({
      model: MODELS.STRONG,
      system,
      user,
      schema: goalReviewSchema,
    });
    return data;
  } catch {
    return {
      summary: accepted.length
        ? `Round produced ${accepted.length} accepted artifact(s); CEO review degraded — criteria unchanged pending founder.`
        : "Round produced no accepted artifacts.",
      criteriaUpdates: [],
      allCriteriaMet: false,
      nextRoundProposal: [],
    };
  }
}

// ── Orchestration: one round ──────────────────────────────────────────────────

export async function runGoalRound(goalId: string): Promise<GoalRoundResult> {
  const goal = await getGoal(goalId);
  if (!goal) throw new Error("Goal not found");
  const company = await store.getCompany(goal.companyId);
  if (!company) throw new Error("Company not found");

  const roundN = goal.rounds.length + 1;
  const runId = makeId("goalrun");
  const log = contextLogger({ traceId: runId, companyId: company.id });
  log.info({ goalId, roundN }, "goal.round.start");

  await updateGoal(goalId, { status: "round_running" });
  emitJobEvent({
    jobRunId: runId,
    companyId: company.id,
    status: "started",
    summary: `Goal round ${roundN}: ${goal.objective.slice(0, 80)}`,
    at: nowIso(),
  });

  // PLAN
  const { plan, degraded } = await planGoalRound(company, goal);
  await appendGoalProgress(goalId, {
    at: nowIso(),
    kind: "round_planned",
    text: `Round ${roundN} planned ${plan.tasks.length} task(s) [effort=${plan.effort}${degraded ? ", degraded" : ""}].`,
    refs: [runId],
  });

  // EXECUTE
  const executed = await executeRoundDag(company, goal, plan, roundN, runId);

  // CRITIC (per artifact)
  const critiques: Record<string, { verdict: string; reason: string }> = {};
  await Promise.all(
    executed.map(async (e) => {
      if (!e.ok) {
        critiques[e.task.id] = { verdict: "retry", reason: "no contract-valid artifact produced" };
        return;
      }
      critiques[e.task.id] = await critiqueArtifact(goal, e.task, e.output);
    }),
  );

  const artifactIds = executed.map((e) => e.artifactId).filter((id): id is string => Boolean(id));
  const costCents = executed.reduce((s, e) => s + e.costCents, 0);

  // CEO GOAL REVIEW
  const review = await reviewGoalProgress(company, goal, executed, critiques);

  // Apply criteria updates (flip to met ONLY with evidence).
  const criteriaDelta: CriteriaDelta[] = [];
  const nextCriteria: SuccessCriterion[] = goal.successCriteria.map((c) => {
    const upd = review.criteriaUpdates.find((u) => u.criterionId === c.id);
    if (!upd) return c;
    const evidence = upd.evidenceArtifactIds.filter((id) => artifactIds.includes(id));
    const newStatus = upd.status === "met" && evidence.length === 0 ? c.status : upd.status;
    if (newStatus !== c.status) {
      criteriaDelta.push({ criterionId: c.id, from: c.status, to: newStatus, evidenceArtifactIds: evidence });
    }
    return { ...c, status: newStatus, evidenceArtifactIds: [...new Set([...c.evidenceArtifactIds, ...evidence])] };
  });

  const allMet = nextCriteria.every((c) => c.status === "met");
  const nextStatus: Goal["status"] = allMet ? "completed" : "awaiting_review";

  await updateGoal(goalId, { successCriteria: nextCriteria, status: nextStatus });
  await addGoalRound(goalId, {
    n: roundN,
    runId,
    plannedTaskCount: plan.tasks.length,
    costCents,
    criteriaDelta,
    summary: review.summary,
    artifactIds,
    at: nowIso(),
  });
  await appendGoalProgress(goalId, {
    at: nowIso(),
    kind: allMet ? "completed" : "round_review",
    text: review.summary,
    refs: artifactIds,
  });

  // §3 self-improvement: mine this round's traces into skill drafts (eval-gated, off by default).
  void deriveSkillDraftsFromGoalRound({
    company,
    goal,
    executed: executed.map((e) => ({ seat: e.task.seat, ok: e.ok, verdict: critiques[e.task.id]?.verdict ?? "n/a", objective: e.task.objective })),
  }).catch(() => undefined);

  emitJobEvent({
    jobRunId: runId,
    companyId: company.id,
    status: allMet ? "completed" : "step",
    summary: review.summary.slice(0, 120),
    at: nowIso(),
  });
  log.info({ goalId, roundN, allMet, artifactCount: artifactIds.length }, "goal.round.complete");

  return {
    goalId,
    roundN,
    runId,
    artifactIds,
    costCents,
    status: nextStatus,
    summary: review.summary,
    criteriaDelta,
  };
}
