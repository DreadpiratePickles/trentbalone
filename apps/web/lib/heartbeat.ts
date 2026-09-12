/**
 * Trent Heartbeat — a competing product-style "the system keeps running while you sleep."
 *
 * Triggered hourly (cron / scheduler) or manually. For each active company it:
 *   1. Inspects current state (pending approvals, blockers, runway, etc).
 *   2. Decides if anything needs autonomous action right now.
 *   3. Kicks off a small orchestrated run (heartbeat trigger).
 *   4. Adds a CEO "autopilot update" message that's waiting in the morning.
 *   5. Runs the self-improvement sweep (Phases 2–4): Foundry + Eval Gate + GEPA.
 *
 * Critically, this loop runs even when the founder is offline — so each
 * Trent company really does "wake up at night, do work, send you an update."
 */

import { store } from "@/lib/store";
import { launchOrchestration } from "@/lib/orchestrator";
import type { Company } from "@/lib/types";
import {
  distillSkillFromTraces,
  InMemorySkillDraftStore,
  type SkillDraftStore,
} from "@/lib/skill-foundry";
import { promoteCandidate, type EvalGateBaseline } from "@/lib/eval-gate";
import {
  evolveRolePrompt,
  worstPerformingRole,
  emptyFrontier,
  type GEPAFrontier,
} from "@/lib/gepa";
import {
  type TraceRecord,
  type TraceStore,
  InMemoryTraceStore,
} from "@/lib/trace-store";
import { computeSkillHealth, isSkillDegraded, describeDegradation } from "@/lib/skill-health";
import { cascadeDegradedSkills, type ToolHealth } from "@/lib/tool-health";
import { publishDegradedTools } from "@/lib/tool-health-cache";
import { proposeDerivedSkillsForCompany } from "@/lib/skill-derive";
import type { EvalSuiteInput } from "@/lib/eval-harness";
import {
  runAutoresearchSweep,
  type AutoresearchSweepReport,
} from "@/lib/self-improvement/heartbeat-autoresearch";
import { InMemoryIterationLog } from "@/lib/self-improvement/iteration-log";
import { PrismaTraceStore } from "@/lib/self-improvement/trace-store.prisma";
import { PrismaSkillDraftStore } from "@/lib/self-improvement/skill-draft-store.prisma";
import { PrismaIterationLog } from "@/lib/self-improvement/iteration-log.prisma";
import { StoreApprovalSink } from "@/lib/self-improvement/store-approval-sink";

/**
 * Slice 3 feature flag. When unset (default) the heartbeat behaves EXACTLY as
 * before — the autoresearch sweep is skipped entirely.
 */
const AUTORESEARCH_ENABLED = process.env.AUTORESEARCH_ENABLED === "1";

export type HeartbeatReport = {
  companyId: string;
  decision: "skip" | "monitor" | "act";
  reason: string;
  runId?: string;
  /** Self-improvement sweep result (if run). */
  improvement?: SelfImprovementReport;
  /** Slice 3 autoresearch sweep result (only when AUTORESEARCH_ENABLED). */
  autoresearch?: AutoresearchSweepReport;
};

export type SelfImprovementReport = {
  skillsDistilled: number;
  skillsPromoted: number;
  gepaPasses: number;
  gepaBestScore?: number;
  /**
   * Live skills the metric monitor flagged as degraded this sweep, with the
   * reasons. Surfaced to the CEO agent's operating summary. Empty when healthy.
   */
  degradedSkills: Array<{ taskType: string; reasons: string[] }>;
  /**
   * Tools the degradation cascade found failing this sweep. Every live skill
   * depending on one of these is force-FIXed. Surfaced to engineer + escalation.
   */
  degradedTools: Array<{ tool: string; successRate: number }>;
  /** DERIVED variants proposed into quarantine this sweep (human-review gated). */
  skillsDerived: number;
  errors: string[];
};

export type SelfImprovementDeps = {
  traceStore: TraceStore;
  draftStore: SkillDraftStore;
  /** Frozen eval suite for gate checks. When omitted, Eval Gate is skipped. */
  frozenSuite?: Omit<EvalSuiteInput, "subjectId" | "previousScore">;
  /** Current baseline for the eval gate.  When omitted, gate is skipped. */
  evalBaseline?: EvalGateBaseline;
  /** Existing GEPA frontier for the worst-performing role. */
  frontier?: GEPAFrontier;
  /** Role system prompt for GEPA reflection.  When omitted, GEPA is skipped. */
  rolePrompt?: string;
  /**
   * When set, the sweep proposes DERIVED, ICP-specialized variants of live skills
   * into quarantine (human-review gated). Omit to skip derivation entirely — the
   * deliberate-trigger default. `label` is the specialization slug source (ICP),
   * `specialization` the free-text guidance (ICP + offer).
   */
  companyContext?: { label: string; specialization: string };
  /** Skip actual LLM calls (for tests). */
  skipLLM?: boolean;
};

/**
 * Self-improvement sweep — runs after each heartbeat for active companies.
 *
 * 1. Harvest traces from the trace store.
 * 2. For each task type with enough signal, run the Skill Foundry.
 * 3. Gate each draft with the Eval Gate (if a frozen suite is provided).
 * 4. Run one GEPA pass on the worst-performing role (if suite + prompt provided).
 *
 * Designed to be non-blocking: errors are captured and returned, not thrown.
 */
export async function runSelfImprovementSweep(
  companyId: string,
  deps: SelfImprovementDeps,
): Promise<SelfImprovementReport> {
  const report: SelfImprovementReport = {
    skillsDistilled: 0,
    skillsPromoted: 0,
    gepaPasses: 0,
    degradedSkills: [],
    degradedTools: [],
    skillsDerived: 0,
    errors: [],
  };

  try {
    const allTraces = await deps.traceStore.query(companyId);
    if (allTraces.length === 0) return report;

    // Group traces by task type
    const byTaskType = new Map<string, TraceRecord[]>();
    for (const t of allTraces) {
      byTaskType.set(t.taskType, [...(byTaskType.get(t.taskType) ?? []), t]);
    }

    // Metric monitor (OpenSpace-style): which live skills have degraded?
    // A degraded skill forces a FIX-style distill pass even with no win to learn from.
    const liveTaskTypeList = await deps.draftStore
      .listLiveTaskTypes(companyId)
      .catch(() => [] as string[]);
    const liveTaskTypes = new Set(liveTaskTypeList);
    const degradedTaskTypes = new Set<string>();
    for (const [taskType, traces] of byTaskType) {
      if (!liveTaskTypes.has(taskType)) continue;
      const health = computeSkillHealth(taskType, traces);
      if (isSkillDegraded(health)) {
        degradedTaskTypes.add(taskType);
        report.degradedSkills.push({ taskType, reasons: describeDegradation(health) });
      }
    }

    // Tool-degradation cascade: when a tool's success rate drops, force-FIX every
    // live skill that depends on it. Fetch live skill bodies to resolve dependents.
    const liveSkills = new Map<string, string>();
    for (const taskType of liveTaskTypeList) {
      const content = await deps.draftStore.readLive(companyId, taskType).catch(() => undefined);
      if (content) liveSkills.set(taskType, content);
    }
    const cascade = cascadeDegradedSkills(allTraces, liveSkills);
    for (const taskType of cascade.degradedTaskTypes) degradedTaskTypes.add(taskType);
    report.degradedTools = cascade.tools.map((t: ToolHealth) => ({
      tool: t.tool,
      successRate: t.successRate,
    }));
    // Publish to the in-memory bridge so live step routing can avoid these tools
    // until they recover (TTL-expired). Empty list clears any prior entry.
    publishDegradedTools(companyId, cascade.tools.map((t) => t.tool));

    for (const [taskType, traces] of byTaskType) {
      try {
        const draft = await distillSkillFromTraces(traces, taskType, {
          companyId,
          draftStore: deps.draftStore,
          skipLLM: deps.skipLLM ?? false,
          existingSkillTaskTypes: liveTaskTypes,
          degradedHealth: degradedTaskTypes.has(taskType),
        });

        if (!draft) continue;
        report.skillsDistilled++;

        // Gate: only promote if we have a frozen suite and baseline
        if (deps.frozenSuite && deps.evalBaseline) {
          const decision = await promoteCandidate(
            { id: draft.id, type: "skill", version: "1.0.0" },
            deps.frozenSuite,
            deps.evalBaseline,
          );
          if (decision.promoted) {
            await deps.draftStore.promote(companyId, taskType);
            report.skillsPromoted++;
          }
        }
      } catch (err) {
        report.errors.push(`skill[${taskType}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // DERIVED pass: when company ICP context is provided, propose specialized
    // variants of live skills into quarantine (human-review gated). Deliberate —
    // skipped entirely without companyContext.
    if (deps.companyContext?.label) {
      try {
        const derived = await proposeDerivedSkillsForCompany({
          companyId,
          draftStore: deps.draftStore,
          label: deps.companyContext.label,
          specialization: deps.companyContext.specialization,
          skipLLM: deps.skipLLM ?? false,
        });
        report.skillsDerived = derived.length;
      } catch (err) {
        report.errors.push(`derive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // GEPA: evolve the worst-performing role if we have what we need
    if (deps.frozenSuite && deps.evalBaseline && deps.rolePrompt) {
      const worst = worstPerformingRole(allTraces);
      if (worst) {
        const failingTraces = allTraces.filter(
          (t) => t.agentRole === worst && t.critiqueVerdict !== "pass",
        );
        const frontier = deps.frontier ?? emptyFrontier(worst);
        try {
          const result = await evolveRolePrompt(
            worst,
            deps.rolePrompt,
            failingTraces,
            deps.frozenSuite,
            deps.evalBaseline,
            frontier,
            { skipLLM: deps.skipLLM ?? false },
          );
          if (result) {
            report.gepaPasses++;
            report.gepaBestScore = result.frontier.best?.score;
          }
        } catch (err) {
          report.errors.push(`gepa[${worst}]: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`sweep: ${err instanceof Error ? err.message : String(err)}`);
  }

  return report;
}

/**
 * Build autoresearch deps: persistent (Prisma) when DATABASE_URL is set, else
 * InMemory equivalents. The approval sink always targets the real `store`.
 */
function buildAutoresearchDeps() {
  if (process.env.DATABASE_URL) {
    return {
      traceStore: new PrismaTraceStore(),
      draftStore: new PrismaSkillDraftStore(),
      iterationLog: new PrismaIterationLog(),
      approvals: new StoreApprovalSink(),
    };
  }
  return {
    traceStore: new InMemoryTraceStore(),
    draftStore: new InMemorySkillDraftStore(),
    iterationLog: new InMemoryIterationLog(),
    approvals: new StoreApprovalSink(),
  };
}

export async function runCompanyHeartbeat(company: Company): Promise<HeartbeatReport> {
  if (company.status !== "active") {
    return { companyId: company.id, decision: "skip", reason: "company paused" };
  }

  // Pull current operating state
  const [tasks, approvals, cycles, documents] = await Promise.all([
    store.listTasks(company.id),
    store.listApprovals(company.id),
    store.listCycles(company.id),
    store.listDocuments(company.id),
  ]);

  const lastCycle = cycles[0];
  const hoursSinceLastCycle = lastCycle?.completedAt
    ? (Date.now() - new Date(lastCycle.completedAt).getTime()) / 36e5
    : Infinity;

  const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
  const stalledTasks = tasks.filter((t) => t.status === "blocked" || t.status === "waiting_approval").length;
  const docFreshness = documents[0]?.createdAt
    ? (Date.now() - new Date(documents[0].createdAt).getTime()) / 36e5
    : Infinity;

  // Decision logic
  let objective = "";
  let reason = "";

  if (hoursSinceLastCycle > 24) {
    objective = `Run a fresh operating heartbeat: check pending tasks, runway signals, and surface 1–3 high-leverage moves for today. ${pendingApprovals} approvals pending. ${stalledTasks} stalled tasks.`;
    reason = Number.isFinite(hoursSinceLastCycle)
      ? `${hoursSinceLastCycle.toFixed(1)}h since last cycle — overdue for a heartbeat.`
      : `No prior cycle on record — first heartbeat.`;
  } else if (pendingApprovals >= 3) {
    objective = `Triage ${pendingApprovals} pending approvals: classify urgency, draft a one-line decision rationale for each, and surface the top 1 that can't wait.`;
    reason = `${pendingApprovals} approvals piling up — clearing the queue.`;
  } else if (stalledTasks >= 5) {
    objective = `Unstick ${stalledTasks} stalled tasks: identify the root blocker for each and propose either a workaround, a hand-off, or a cancel.`;
    reason = `${stalledTasks} stalled tasks — too much WIP.`;
  } else if (docFreshness > 48) {
    objective = `Refresh the company brief: incorporate latest cycles and decisions into vision/ICP/offer. Write any updates as new working-memory docs.`;
    reason = `Company memory hasn't been touched in 48h — refreshing.`;
  } else {
    return { companyId: company.id, decision: "monitor", reason: "company healthy — no action needed" };
  }

  try {
    const run = await launchOrchestration({
      companyId: company.id,
      objective,
      trigger: "heartbeat",
    });

    // Run self-improvement sweep in parallel with the main heartbeat result.
    // Errors are captured in the report and never block the heartbeat decision.
    const improvement = await runSelfImprovementSweep(company.id, {
      traceStore: new InMemoryTraceStore(),
      draftStore: new InMemorySkillDraftStore(),
    }).catch(() => undefined);

    // Slice 3 — autoresearch sweep. Behind a feature flag; default OFF means the
    // heartbeat behaves identically to before. Non-blocking: errors never throw.
    let autoresearch: AutoresearchSweepReport | undefined;
    if (AUTORESEARCH_ENABLED) {
      autoresearch = await runAutoresearchSweep(company.id, buildAutoresearchDeps()).catch(
        () => undefined,
      );
    }

    return { companyId: company.id, decision: "act", reason, runId: run.id, improvement, autoresearch };
  } catch (err) {
    return {
      companyId: company.id,
      decision: "skip",
      reason: err instanceof Error ? err.message : "heartbeat failed",
    };
  }
}

export async function runHeartbeatSweep(): Promise<HeartbeatReport[]> {
  const companies = await store.listCompanies();
  const out: HeartbeatReport[] = [];
  for (const c of companies) {
    if (c.status !== "active") continue;
    out.push(await runCompanyHeartbeat(c));
  }
  return out;
}
