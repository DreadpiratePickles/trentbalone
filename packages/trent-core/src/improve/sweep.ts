/**
 * Item 2 of the loop — the sweep on real stores.
 *
 * `heartbeat.ts:335` built fresh in-memory stores for every sweep, so production learned nothing.
 * This sweep reads the durable trace store, runs the Skill Foundry per (agent, taskType), gates
 * every draft by EXECUTING it (`gate.ts`), evolves each agent's prompt on its own persisted Pareto
 * frontier (`gepa-pass.ts`), and retires what nobody uses. It is idempotent: an (agent, taskType)
 * whose trace set has not changed since its last iteration is skipped, so a second sweep over the
 * same traces produces nothing new.
 *
 * Triggers stay deterministic (`shouldDistillSkill`): no "be ACTIVE" bias is adopted.
 */

import type { AgentTraceRow, ImproveStorePort, IterationRow, JsonValue, SkillDraftRow } from "../store/StorePort.js";
import { createSkillFoundry, type SkillDraftStore } from "../skills/foundry.js";
import type { TraceRecord } from "../traces/trace-store.js";
import { executeGate, measureBaseline, type ActualsRunner, type GateBaseline, type GateVerdict, type JudgeFn } from "./gate.js";
import { runGepaPass, type ReflectFn } from "./gepa-pass.js";
import { contentHash, newId, nowIso, setHash } from "./ledger.js";
import { retireSkills, type RetirementReport } from "./lifecycle.js";
import { resolveSweepScope, type SkippedSpecialist } from "./scope.js";
import { defaultSeatPromptProvider, type SeatPromptProvider } from "./seat-prompt.js";
import type { SuiteProvider } from "./suites.js";

export interface SweepDeps {
  readonly store: ImproveStorePort;
  readonly installedAgents: readonly string[];
  readonly agentFilter?: string;
  readonly distillThreshold?: number;
  /** Default TRUE: the Foundry and GEPA use their deterministic fallbacks; no model is called. */
  readonly skipLLM?: boolean;
  readonly seatPrompt?: SeatPromptProvider;
  readonly suiteFor?: SuiteProvider;
  /** The executing gate's model access. Without it no draft can be gated (it stays quarantined). */
  readonly actuals?: ActualsRunner;
  readonly judge?: JudgeFn;
  /** GEPA reflection model, used only when `skipLLM` is false. */
  readonly reflect?: ReflectFn;
  readonly listedSkills?: ReadonlySet<string>;
  readonly retirement?: { staleAfterDays?: number; archiveAfterDays?: number };
  readonly now?: () => string;
}

export interface AgentSweepReport {
  agentId: string;
  traces: number;
  skillsDistilled: number;
  skillsGated: number;
  skillsRejected: number;
  gepaPasses: number;
  gepaBestScore?: number;
  degradedSkills: Array<{ taskType: string; reasons: string[] }>;
  degradedTools: Array<{ tool: string; successRate: number }>;
  skipped: string[];
  errors: string[];
}

export interface SweepReport {
  companyId: string;
  at: string;
  agents: AgentSweepReport[];
  skippedSpecialists: SkippedSpecialist[];
  retirement: RetirementReport;
  costCents: number;
  errors: string[];
}

export function toTraceRecord(row: AgentTraceRow): TraceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    runId: row.runId,
    taskType: row.taskType,
    agentRole: row.agentRole as TraceRecord["agentRole"],
    stepTitle: row.stepTitle,
    status: row.status as TraceRecord["status"],
    toolCalls: [...row.toolCalls],
    toolCallCount: row.toolCallCount,
    ...(row.critiqueVerdict === null ? {} : { critiqueVerdict: row.critiqueVerdict as TraceRecord["critiqueVerdict"] }),
    ...(row.improvement === null ? {} : { improvement: row.improvement }),
    ...(row.evalScore === null ? {} : { evalScore: row.evalScore }),
    costCents: row.costCents,
    ...(row.latencyMs === null ? {} : { latencyMs: row.latencyMs }),
    humanCorrected: row.humanCorrected,
    skillApplied: row.skillApplied,
    createdAt: row.createdAt,
  };
}

/** Adapts the per-agent draft rows to the Foundry's store port. Writes are captured, not persisted. */
function foundryDraftStore(store: ImproveStorePort, agentId: string, onWrite: (content: string) => void): SkillDraftStore {
  const find = async (companyId: string, taskType: string, status: SkillDraftRow["status"]) =>
    (await store.listDrafts(companyId, { agentId, taskType, kind: "skill", status }))[0];
  return {
    async writeQuarantine(_companyId, _taskType, content) {
      onWrite(content);
      return "pending";
    },
    async readQuarantine(companyId, taskType) {
      return (await find(companyId, taskType, "quarantine"))?.content;
    },
    async promote() {
      /* promotion is a human command through lifecycle.ts, never the Foundry's */
    },
    async readLive(companyId, taskType) {
      return (await find(companyId, taskType, "live"))?.content;
    },
    async listLiveTaskTypes(companyId) {
      return (await store.listDrafts(companyId, { agentId, kind: "skill", status: "live" })).map((d) => d.taskType);
    },
  };
}

type Health = {
  degraded: Set<string>;
  degradedSkills: AgentSweepReport["degradedSkills"];
  degradedTools: AgentSweepReport["degradedTools"];
};

/** The metric monitor and the tool cascade, from the wrapped pure modules. */
async function assessHealth(traces: readonly TraceRecord[], byTaskType: Map<string, TraceRecord[]>, liveSkills: Map<string, string>): Promise<Health> {
  const [{ computeSkillHealth, isSkillDegraded, describeDegradation }, { cascadeDegradedSkills }] = await Promise.all([
    import("@/lib/skill-health"),
    import("@/lib/tool-health"),
  ]);
  const health: Health = { degraded: new Set(), degradedSkills: [], degradedTools: [] };
  for (const [taskType, group] of byTaskType) {
    if (!liveSkills.has(taskType)) continue;
    const h = computeSkillHealth(taskType, group as unknown as Parameters<typeof computeSkillHealth>[1]);
    if (isSkillDegraded(h)) {
      health.degraded.add(taskType);
      health.degradedSkills.push({ taskType, reasons: describeDegradation(h) });
    }
  }
  const cascade = cascadeDegradedSkills(traces as unknown as Parameters<typeof cascadeDegradedSkills>[0], liveSkills);
  for (const taskType of cascade.degradedTaskTypes) health.degraded.add(taskType);
  health.degradedTools = cascade.tools.map((t) => ({ tool: t.tool, successRate: t.successRate }));
  return health;
}

interface AgentContext {
  companyId: string;
  agentId: string;
  deps: SweepDeps;
  now: string;
  report: AgentSweepReport;
  baseline: () => Promise<GateBaseline | undefined>;
  seatPrompt: () => Promise<string>;
  suite: Awaited<ReturnType<SuiteProvider>>;
}

function verdictJson(verdict: GateVerdict): JsonValue {
  return JSON.parse(JSON.stringify(verdict)) as JsonValue;
}

async function gateDraft(ctx: AgentContext, draft: SkillDraftRow): Promise<Pick<IterationRow, "decision" | "score" | "delta" | "blockedBy" | "verdicts">> {
  if (!ctx.suite) return { decision: "quarantined", score: null, delta: null, blockedBy: "no_suite", verdicts: null };
  if (!ctx.deps.actuals) return { decision: "quarantined", score: null, delta: null, blockedBy: "no_gateway", verdicts: null };
  const baseline = await ctx.baseline();
  if (!baseline) return { decision: "quarantined", score: null, delta: null, blockedBy: "no_baseline", verdicts: null };
  const verdict = await executeGate({
    candidate: { id: draft.id, kind: "skill", content: draft.content },
    seatPrompt: await ctx.seatPrompt(),
    suite: ctx.suite,
    baseline,
    actuals: ctx.deps.actuals,
    ...(ctx.deps.judge === undefined ? {} : { judge: ctx.deps.judge }),
  });
  if (verdict.promoted) {
    ctx.report.skillsGated += 1;
    return { decision: "pending_approval", score: verdict.score, delta: verdict.delta, blockedBy: null, verdicts: verdictJson(verdict) };
  }
  ctx.report.skillsRejected += 1;
  await ctx.deps.store.updateDraft(draft.id, { status: "rejected", retiredAt: ctx.now });
  return { decision: "rejected", score: verdict.score, delta: verdict.delta, blockedBy: verdict.blockedBy ?? null, verdicts: verdictJson(verdict) };
}

async function sweepTaskType(ctx: AgentContext, taskType: string, group: TraceRecord[], live: Set<string>, degraded: boolean): Promise<void> {
  const { store, skipLLM } = ctx.deps;
  const inputHash = setHash(group.map((t) => t.id), degraded ? "degraded" : "");
  const previous = await store.listIterations(ctx.companyId, { agentId: ctx.agentId, taskType, limit: 1 });
  if (previous[0]?.inputHash === inputHash) {
    ctx.report.skipped.push(`${taskType}: unchanged`);
    return;
  }

  let captured: string | undefined;
  const foundry = await createSkillFoundry({
    companyId: ctx.companyId,
    draftStore: foundryDraftStore(store, ctx.agentId, (content) => (captured = content)),
    skipLLM: skipLLM ?? true,
  });
  const distilled = await foundry.distill(group, taskType, { existingSkillTaskTypes: live, degradedHealth: degraded, now: ctx.now });

  const iteration: IterationRow = {
    id: newId("iter"),
    companyId: ctx.companyId,
    agentId: ctx.agentId,
    taskType,
    candidateId: null,
    candidateKind: null,
    score: null,
    delta: null,
    decision: "no_candidate",
    triggers: distilled?.triggeredBy ?? [],
    blockedBy: null,
    inputHash,
    verdicts: null,
    createdAt: ctx.now,
  };
  if (distilled && captured !== undefined) {
    const draft: SkillDraftRow = {
      id: newId("skill"),
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      taskType,
      kind: "skill",
      status: "quarantine",
      content: captured,
      contentHash: contentHash(captured),
      triggers: distilled.triggeredBy,
      createdAt: ctx.now,
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    };
    await store.createDraft(draft);
    ctx.report.skillsDistilled += 1;
    Object.assign(iteration, { candidateId: draft.id, candidateKind: "skill" }, await gateDraft(ctx, draft));
  }
  await store.appendIteration(iteration);
}

async function sweepAgent(companyId: string, agentId: string, rows: AgentTraceRow[], deps: SweepDeps, now: string, seatPrompt: SeatPromptProvider): Promise<AgentSweepReport> {
  const report: AgentSweepReport = {
    agentId,
    traces: rows.length,
    skillsDistilled: 0,
    skillsGated: 0,
    skillsRejected: 0,
    gepaPasses: 0,
    degradedSkills: [],
    degradedTools: [],
    skipped: [],
    errors: [],
  };
  if (rows.length === 0) return report;
  const traces = rows.map(toTraceRecord);
  const byTaskType = new Map<string, TraceRecord[]>();
  for (const t of traces) byTaskType.set(t.taskType, [...(byTaskType.get(t.taskType) ?? []), t]);

  const liveSkills = new Map((await deps.store.listDrafts(companyId, { agentId, kind: "skill", status: "live" })).map((d) => [d.taskType, d.content]));
  const health = await assessHealth(traces, byTaskType, liveSkills);
  report.degradedSkills = health.degradedSkills;
  report.degradedTools = health.degradedTools;

  const suite = await deps.suiteFor?.(agentId);
  let cachedPrompt: Promise<string> | undefined;
  let cachedBaseline: Promise<GateBaseline | undefined> | undefined;
  const ctx: AgentContext = {
    companyId,
    agentId,
    deps,
    now,
    report,
    suite,
    seatPrompt: () => (cachedPrompt ??= seatPrompt(agentId)),
    baseline: () =>
      (cachedBaseline ??= (async () => {
        if (!suite || !deps.actuals) return undefined;
        return measureBaseline({ seatPrompt: await ctx.seatPrompt(), suite, actuals: deps.actuals, ...(deps.judge === undefined ? {} : { judge: deps.judge }) });
      })()),
  };

  for (const [taskType, group] of byTaskType) {
    try {
      await sweepTaskType(ctx, taskType, group, new Set(liveSkills.keys()), health.degraded.has(taskType));
    } catch (error) {
      report.errors.push(`skill[${taskType}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const gepa = await runGepaPass({
      store: deps.store,
      companyId,
      agentId,
      role: traces[0]!.agentRole,
      traces,
      suite,
      seatPrompt: ctx.seatPrompt,
      baseline: ctx.baseline,
      ...(deps.actuals === undefined ? {} : { actuals: deps.actuals }),
      ...(deps.judge === undefined ? {} : { judge: deps.judge }),
      ...(deps.reflect === undefined ? {} : { reflect: deps.reflect }),
      skipLLM: deps.skipLLM ?? true,
      now,
    });
    if (gepa.passed) report.gepaPasses += 1;
    if (gepa.bestScore !== undefined) report.gepaBestScore = gepa.bestScore;
    if (gepa.skipped) report.skipped.push(`gepa: ${gepa.skipped}`);
  } catch (error) {
    report.errors.push(`gepa: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

/** One sweep over every agent in scope. Never throws: per-agent failures land in the report. */
export async function runImprovementSweep(companyId: string, deps: SweepDeps): Promise<SweepReport> {
  const now = (deps.now ?? nowIso)();
  const report: SweepReport = { companyId, at: now, agents: [], skippedSpecialists: [], retirement: { stale: [], archived: [], kept: [] }, costCents: 0, errors: [] };
  try {
    const counts = await deps.store.countTracesByAgent(companyId);
    const scope = resolveSweepScope({
      installedAgents: deps.installedAgents,
      traceCounts: counts,
      ...(deps.distillThreshold === undefined ? {} : { threshold: deps.distillThreshold }),
      ...(deps.agentFilter === undefined ? {} : { agentFilter: deps.agentFilter }),
    });
    report.skippedSpecialists = scope.skipped;

    const roleHints = new Map<string, string>();
    const rowsByAgent = new Map<string, AgentTraceRow[]>();
    for (const agentId of scope.agents) {
      const rows = await deps.store.listTraces(companyId, { agentId });
      rowsByAgent.set(agentId, rows);
      if (rows[0]) roleHints.set(agentId, rows[0].agentRole);
    }
    const seatPrompt = deps.seatPrompt ?? defaultSeatPromptProvider(deps.store, companyId, (id) => roleHints.get(id));

    for (const agentId of scope.agents) {
      try {
        report.agents.push(await sweepAgent(companyId, agentId, rowsByAgent.get(agentId) ?? [], deps, now, seatPrompt));
      } catch (error) {
        report.errors.push(`agent[${agentId}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    report.retirement = await retireSkills(deps.store, companyId, { now, listed: deps.listedSkills ?? new Set(), ...deps.retirement });
  } catch (error) {
    report.errors.push(`sweep: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}
