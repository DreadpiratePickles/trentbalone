import { z } from "zod";
import type { AgentRole } from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";
import { appendAuditLog } from "@/lib/audit-log";
import { assertSpendAvailable } from "@/lib/spend";
import { logger } from "@/lib/logger";
import { buildOrchestratorSeatDossier, buildSeatContextBundle, getSeatManifest } from "@/lib/seat-manifest";
import { formatPlanValidationErrors, validatePlan } from "@/lib/plan-validator";
import { seatOutputSchemas } from "@/lib/seat-output-schemas";

/** Hard cap on dynamic collaboration depth — prevents runaway agent spawning. */
export const MAX_FANOUT_DEPTH = 3;
/** Max independent workers the CEO will spawn in parallel for one request. */
export const MAX_PARALLEL_WORKERS = 5;
/** Max re-plan iterations before the cycle fails or escalates. */
export const MAX_REPLAN_ITERATIONS = 3;

export type TaskComplexity = "trivial" | "standard" | "complex";
export type Reversibility = "reversible" | "costly" | "irreversible";

/** Output of the cheap classifier that drives adaptive routing (§3.2). */
export const taskClassificationSchema = z.object({
  type: z.string(),
  complexity: z.enum(["trivial", "standard", "complex"]),
  reversibility: z.enum(["reversible", "costly", "irreversible"]),
});
export type TaskClassification = z.infer<typeof taskClassificationSchema>;

export const subtaskSpecSchema = z.object({
  acceptance: z.array(z.string().min(1)).min(1),
  inputsFrom: z.array(z.string()).default([]),
});
export type SubtaskSpec = z.infer<typeof subtaskSpecSchema>;

/** A typed subtask the CEO hands to a worker seat. Vague subtasks are the #1
 * documented multi-agent failure, so every field is required. */
export const subtaskSchema = z.object({
  id: z.string(),
  seat: z.custom<AgentRole>(),
  objective: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  spec: subtaskSpecSchema.default({
    acceptance: ["Complete the subtask objective."],
    inputsFrom: [],
  }),
  /** ID of the Zod output contract the worker MUST satisfy. */
  outputContractId: z.string().min(1),
  toolGuidance: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  input: z.unknown(),
  contextBundle: z.record(z.string(), z.unknown()).default({}),
  classification: taskClassificationSchema,
  budgetCents: z.number().int().nonnegative(),
});
export type ParsedSubtask = z.infer<typeof subtaskSchema>;
export type Subtask = Omit<ParsedSubtask, "dependsOn" | "spec"> & {
  dependsOn?: string[];
  spec?: SubtaskSpec;
};

/** Logged for every routing decision — the a competing product-beating accountability surface (§3.5). */
export const routingDecisionSchema = z.object({
  cycleId: z.string(),
  task: z.string(),
  candidateSeats: z.array(z.custom<AgentRole>()),
  chosenSeat: z.custom<AgentRole>(),
  classifierConfidence: z.number().min(0).max(1),
  chosenModel: z.string(),
  whyText: z.string(),
  budgetCents: z.number().int().nonnegative(),
});
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/** Every seat→seat / seat→CEO / Plug→Plug transfer is one of these (§2.5/§3.7). */
export const handoffEventSchema = z.object({
  cycleId: z.string(),
  from: z.custom<AgentRole>(),
  to: z.custom<AgentRole>(),
  reason: z.string(),
  severity: z.enum(["green", "amber", "red"]).default("green"),
  summary: z.string().default(""),
  nextActions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  /** Pointer into lib/artifacts.ts — never the full payload (avoids context blowup). */
  payloadRef: z.string(),
  whatIDidNotDo: z.array(z.string()).default([]),
  contractVersion: z.string(),
  timestamp: z.string(),
});
export type HandoffEvent = z.infer<typeof handoffEventSchema>;

/** A seat asking the orchestrator to route work to another seat at runtime (§3.15). */
export const workRequestSchema = z.object({
  id: z.string(),
  cycleId: z.string(),
  companyId: z.string(),
  requester: z.custom<AgentRole>(),
  /** Capability needed, matched against the seat/Plug registry (§4.2/§3.16). */
  capability: z.string().min(1),
  input: z.unknown(),
  budgetCents: z.number().int().nonnegative(),
  /** Incremented on each hop; rejected past MAX_FANOUT_DEPTH. */
  depth: z.number().int().nonnegative().default(0),
});
export type WorkRequest = z.infer<typeof workRequestSchema>;

/** What a worker returns to the orchestrator. */
export const seatResultSchema = z.object({
  seat: z.custom<AgentRole>(),
  /** Artifact reference, not the full blob. */
  payloadRef: z.string(),
  /** 0.0–1.0 combined-signal confidence (§3.6). */
  confidence: z.number().min(0).max(1),
  costCents: z.number().int().nonnegative(),
  /** Optional follow-on work the seat wants done (dynamic collaboration). */
  workRequests: z.array(workRequestSchema).default([]),
  /** Explicit not-attempted work, so downstream seats do not infer it was done. */
  whatIDidNotDo: z.array(z.string()).default([]),
  /** Present when a seat failed but sibling work should still be preserved. */
  error: z.string().optional(),
});
export interface SeatResult {
  seat: AgentRole;
  payloadRef: string;
  confidence: number;
  costCents: number;
  workRequests?: WorkRequest[];
  whatIDidNotDo?: string[];
  error?: string;
}

/** A worker seat runner. Injected so the orchestrator is unit-testable without a
 * live model or queue (TDD-friendly). The real implementation lives in
 * lib/seat-worker.ts; tests pass a fake. */
export interface SeatRunner {
  run(subtask: Subtask): Promise<SeatResult>;
}

export interface CycleRequest {
  companyId: string;
  cycleId?: string;
  /** Natural-language request (from scheduler or "Ask Trent"). */
  prompt: string;
  context?: Record<string, unknown>;
}

export interface CycleResult {
  cycleId: string;
  status: "completed" | "escalated" | "failed";
  results: SeatResult[];
  /** Set when low confidence / irreversible work routed to a human (§3.6). */
  escalationReason?: string;
}

function planValidatorEnabled(): boolean {
  return process.env.ORCHESTRATION_PLAN_VALIDATOR_ENABLED === "1";
}

function buildSubtaskSpec(objective: string, inputsFrom: string[] = []): SubtaskSpec {
  return {
    acceptance: [`Complete objective: ${objective}`],
    inputsFrom,
  };
}

/** Cheap intent/complexity classifier. Route UP when ambiguous, never down. */
export async function classifyTask(prompt: string): Promise<TaskClassification> {
  const lower = prompt.toLowerCase();
  const irreversible = /(deploy|send|charge|publish|launch|delete|merge)/.test(lower);
  return taskClassificationSchema.parse({
    type: "general",
    complexity: irreversible ? "complex" : "standard",
    reversibility: irreversible ? "irreversible" : "reversible",
  });
}

/** Decompose a request into typed subtasks with output contracts. */
export async function plan(request: CycleRequest, cycleId: string): Promise<ParsedSubtask[]> {
  const classification = await classifyTask(request.prompt);
  const seats = selectPlannerSeats(request.prompt, classification);
  logger.info({ cycleId, classification, seats }, "[planner] planned deterministic subtasks");
  return seats.map((seat) =>
    subtaskSchema.parse({
      id: makeId("subtask"),
      seat,
      objective: buildSeatObjective(seat, request.prompt),
      dependsOn: [],
      spec: buildSubtaskSpec(buildSeatObjective(seat, request.prompt)),
      outputContractId: `${seat}.v1`,
      toolGuidance: buildToolGuidance(seat),
      boundaries: buildSeatBoundaries(seat, classification),
      input: { prompt: request.prompt, seat },
      contextBundle: buildSeatContextBundle(seat, request.context ?? {}),
      classification,
      budgetCents: budgetForSeat(seat),
    })
  );
}

function validateSubtasksBeforeExecution(subtasks: ParsedSubtask[], request: CycleRequest): void {
  if (!planValidatorEnabled()) return;
  const plannedBudgetCents = subtasks.reduce((sum, subtask) => sum + subtask.budgetCents, 0);
  const validation = validatePlan(subtasks, {
    seatRoster: Object.keys(seatOutputSchemas) as AgentRole[],
    budgetCapCents: budgetCapCentsFor(request, plannedBudgetCents),
  });
  if (!validation.ok) {
    throw new Error(`Invalid subtask plan: ${formatPlanValidationErrors(validation.errors)}`);
  }
}

function budgetCapCentsFor(request: CycleRequest, fallback: number): number {
  const cap = request.context?.budgetCapCents;
  return typeof cap === "number" && Number.isFinite(cap) && cap >= 0 ? cap : fallback;
}

function selectPlannerSeats(prompt: string, classification: TaskClassification): AgentRole[] {
  const lower = prompt.toLowerCase();
  const seats = new Set<AgentRole>();
  if (/(strategy|prioritize|roadmap|synthesis|coordinate|operating plan)/.test(lower)) seats.add("ceo");
  if (/(code|build|deploy|test|bug|repo|pr|github|landing page|app|fix)/.test(lower)) seats.add("engineer");
  if (/(ad|ads|campaign|growth|acquisition|seo|paid|funnel|launch)/.test(lower)) seats.add("growth");
  if (/(copy|content|email|post|creative|landing page|draft|nurture)/.test(lower)) seats.add("content");
  if (/(support|ticket|customer|reply|inbox|ops|operations)/.test(lower)) seats.add("support");
  if (/(spend|billing|ledger|revenue|finance|refund|budget|runway|cost)/.test(lower)) seats.add("finance");
  if (/(metric|analytics|analysis|summarize|report|retention|churn|risk|research|web|website|screenshot|competitor|market)/.test(lower)) seats.add("analyst");
  if (/(sales|prospect|pipeline|crm|lead|leads|deal|outbound|follow[- ]?up)/.test(lower)) seats.add("sales");
  if (
    classification.reversibility === "irreversible"
    || /(approval|approve|legal|compliance|charge|publish|send|merge|delete|deploy)/.test(lower)
  ) {
    seats.add("escalation");
  }
  if (seats.size === 0) seats.add("analyst");
  const order: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];
  return order.filter((seat) => seats.has(seat));
}

function buildSeatObjective(seat: AgentRole, prompt: string) {
  return `${seat} contribution for: ${prompt}`;
}

function buildToolGuidance(seat: AgentRole) {
  if (seat === "escalation") return ["prepare approval card; do not execute external action"];
  if (seat === "analyst") return ["research only; cite sources and avoid authenticated writes"];
  if (seat === "sales") return ["draft only; do not send outbound or update CRM without approval"];
  if (seat === "engineer") return ["plan code safely; do not merge or deploy"];
  return [];
}

function buildSeatBoundaries(seat: AgentRole, classification: TaskClassification) {
  const boundaries = ["no external side effects without approval"];
  if (classification.reversibility === "irreversible") boundaries.push("irreversible action requires human approval");
  if (seat === "finance") boundaries.push("enforce spend and budget constraints");
  if (seat === "support" || seat === "content" || seat === "sales") boundaries.push("draft only; do not send");
  return boundaries;
}

function budgetForSeat(seat: AgentRole) {
  if (seat === "finance" || seat === "escalation") return 20;
  if (seat === "analyst" || seat === "sales") return 30;
  return 50;
}

function classifierConfidenceFor(classification: TaskClassification) {
  if (classification.reversibility === "irreversible") return 0.78;
  if (classification.complexity === "complex") return 0.74;
  if (classification.complexity === "trivial") return 0.9;
  return 0.84;
}

/** Map complexity/reversibility → effort tier. Logged via recordRouting. */
export function decideEffort(c: TaskClassification): {
  needsCritic: boolean;
  needsVerifier: boolean;
  needsHumanGate: boolean;
} {
  if (c.reversibility === "irreversible" || c.complexity === "complex") {
    return { needsCritic: true, needsVerifier: true, needsHumanGate: true };
  }
  if (c.complexity === "standard") {
    return { needsCritic: true, needsVerifier: false, needsHumanGate: false };
  }
  return { needsCritic: false, needsVerifier: false, needsHumanGate: false };
}

export async function recordRouting(companyId: string, decision: RoutingDecision): Promise<void> {
  const valid = routingDecisionSchema.parse(decision);
  await appendAuditLog(
    companyId,
    "agent",
    "route_subtask",
    "routing_decision",
    valid.cycleId,
    `${valid.chosenSeat} via ${valid.chosenModel}: candidates=${valid.candidateSeats.join(",")}; ${valid.whyText}`
  );
}

export async function recordHandoff(companyId: string, event: HandoffEvent): Promise<void> {
  const valid = handoffEventSchema.parse(event);
  await appendAuditLog(
    companyId,
    "agent",
    "handoff",
    "handoff_event",
    valid.cycleId,
    `${valid.from} -> ${valid.to}: ${valid.reason}`
  );
}

/** Authorise a dynamic WorkRequest: enforce fan-out depth + spend cap. Returns a
 * reason string when rejected (caller escalates), or null when authorised. */
export async function authorizeWorkRequest(req: WorkRequest): Promise<string | null> {
  const valid = workRequestSchema.parse(req);
  if (valid.depth >= MAX_FANOUT_DEPTH) {
    return `fan-out depth ${valid.depth} exceeds MAX_FANOUT_DEPTH (${MAX_FANOUT_DEPTH})`;
  }
  try {
    await assertSpendAvailable(valid.companyId, valid.budgetCents, `WorkRequest ${valid.capability}`);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "spend cap exceeded";
  }
  return null;
}

export async function runPlannedSubtasks(subtasks: Subtask[], runner: SeatRunner): Promise<SeatResult[]> {
  const results: SeatResult[] = [];
  for (let index = 0; index < subtasks.length; index += MAX_PARALLEL_WORKERS) {
    const batch = subtasks.slice(index, index + MAX_PARALLEL_WORKERS);
    const settled = await Promise.allSettled(batch.map((subtask) => runner.run(subtask)));
    settled.forEach((result, batchIndex) => {
      if (result.status === "fulfilled") {
        results.push(seatResultSchema.parse(result.value));
        return;
      }
      const subtask = batch[batchIndex];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error({ seat: subtask.seat, subtaskId: subtask.id, err: message }, "[planner] seat failed");
      results.push(seatResultSchema.parse({
        seat: subtask.seat,
        payloadRef: "",
        confidence: 0,
        costCents: 0,
        workRequests: [],
        error: message,
      }));
    });
  }
  return results;
}

async function runDynamicWorkRequests(input: {
  companyId: string;
  cycleId: string;
  requests: WorkRequest[];
  runner: SeatRunner;
  baseContext: Record<string, unknown>;
  depth: number;
}): Promise<SeatResult[]> {
  if (input.requests.length === 0) return [];

  const subtasks: ParsedSubtask[] = [];
  for (const request of input.requests) {
    const req = workRequestSchema.parse({
      ...request,
      depth: Math.max(request.depth ?? 0, input.depth),
    });
    const rejection = await authorizeWorkRequest(req);
    if (rejection) {
      logger.warn({ cycleId: input.cycleId, capability: req.capability, rejection }, "[planner] work request rejected");
      await appendAuditLog(input.companyId, "agent", "work_request_rejected", "cycle", input.cycleId, rejection);
      continue;
    }

    const seat = resolveCapabilitySeat(req.capability);
    const classification = await classifyTask(req.capability);
    subtasks.push(subtaskSchema.parse({
      id: makeId("subtask"),
      seat,
      objective: req.capability,
      dependsOn: [],
      spec: buildSubtaskSpec(req.capability, [req.id]),
      outputContractId: `${seat}.v1`,
      input: req.input,
      contextBundle: buildSeatContextBundle(seat, input.baseContext),
      classification,
      budgetCents: req.budgetCents,
    }));
    await recordHandoff(input.companyId, {
      cycleId: input.cycleId,
      from: req.requester,
      to: seat,
      reason: req.capability,
      severity: "green",
      summary: req.capability,
      nextActions: [req.capability],
      risks: [],
      payloadRef: req.id,
      whatIDidNotDo: [],
      contractVersion: "v1",
      timestamp: nowIso(),
    });
  }

  const results = await runPlannedSubtasks(subtasks, input.runner);
  const childRequests = results.flatMap((result) => result.workRequests ?? []);
  const childResults = await runDynamicWorkRequests({
    companyId: input.companyId,
    cycleId: input.cycleId,
    requests: childRequests,
    runner: input.runner,
    baseContext: input.baseContext,
    depth: input.depth + 1,
  });
  return [...results, ...childResults];
}

// ---------------------------------------------------------------------------
// 3. The orchestration loop
// ---------------------------------------------------------------------------

/** Run one supervised cycle: plan → route → spawn isolated workers (parallel) →
 * collect refs → handle dynamic WorkRequests (depth-capped) → synthesise.
 * `runner` is injected; in production it dispatches to the BullMQ seat-worker. */
export async function runCycle(request: CycleRequest, runner: SeatRunner): Promise<CycleResult> {
  const cycleId = request.cycleId ?? makeId("cycle");
  const companyId = request.companyId;

  try {
    const subtasks = await plan(request, cycleId);
    validateSubtasksBeforeExecution(subtasks, request);
    const seatUniverse = buildOrchestratorSeatDossier().seats.map((seat) => seat.role);

    // Route + log every subtask before doing any work.
    for (const subtask of subtasks) {
      const effort = decideEffort(subtask.classification);
      await recordRouting(companyId, {
        cycleId,
        task: subtask.objective,
        candidateSeats: seatUniverse,
        chosenSeat: subtask.seat,
        classifierConfidence: classifierConfidenceFor(subtask.classification),
        chosenModel: getSeatManifest(subtask.seat).modelTier,
        whyText: `seat=${subtask.seat}; context=${Object.keys(subtask.contextBundle).join(",") || "none"}; complexity=${subtask.classification.complexity}, reversibility=${subtask.classification.reversibility}, critic=${effort.needsCritic}, verifier=${effort.needsVerifier}`,
        budgetCents: subtask.budgetCents,
      });
    }

    // Spawn workers in parallel for independent subtasks, batching instead of
    // dropping work beyond the concurrency cap.
    const results = await runPlannedSubtasks(subtasks, runner);

    // Handle dynamic collaboration requests recursively, depth-capped + authorised.
    const followOnResults = await runDynamicWorkRequests({
      companyId,
      cycleId,
      requests: results.flatMap((r) => r.workRequests ?? []),
      runner,
      baseContext: request.context ?? {},
      depth: 0,
    });

    // Synthesis + confidence gate (§3.6). Low confidence / irreversible -> human.
    const allResults = [...results, ...followOnResults];
    const lowConfidence = allResults.some((r) => r.confidence < 0.6);
    const anyIrreversible = subtasks.some((s) => s.classification.reversibility === "irreversible");
    if (lowConfidence || anyIrreversible) {
      const reason = lowConfidence ? "low combined-signal confidence" : "irreversible action requires approval";
      await appendAuditLog(companyId, "system", "escalate", "cycle", cycleId, reason);
      return { cycleId, status: "escalated", results: allResults, escalationReason: reason };
    }

    return { cycleId, status: "completed", results: allResults };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown orchestrator error";
    logger.error({ cycleId, err: message }, "[planner] cycle failed");
    await appendAuditLog(companyId, "system", "cycle_failed", "cycle", cycleId, message);
    return { cycleId, status: "failed", results: [], escalationReason: message };
  }
}

function resolveCapabilitySeat(capability: string) {
  const lower = capability.toLowerCase();
  if (/(code|test|deploy|repo|security)/.test(lower)) return "engineer";
  if (/(spend|billing|ledger|revenue|finance|refund|budget)/.test(lower)) return "finance";
  if (/(campaign|seo|ad|growth|audience|outbound)/.test(lower)) return "growth";
  if (/(copy|content|post|email|creative)/.test(lower)) return "content";
  if (/(ticket|support|reply|customer)/.test(lower)) return "support";
  if (/(sales|prospect|pipeline|crm|lead|outbound|follow[- ]?up)/.test(lower)) return "sales";
  if (/(browser|research|web|screenshot)/.test(lower)) return "analyst";
  return "analyst";
}
