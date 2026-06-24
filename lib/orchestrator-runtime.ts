import { z } from "zod";
import { adapters as defaultAdapters, type ToolAdapter } from "@/lib/tools";
import { getAgentRuntime } from "@/lib/agent-runtime";
import { assertAgentTokenBudget, assertSpendAvailable } from "@/lib/spend";
import { store } from "@/lib/store";
import { getApprovalExpiryHours } from "@/lib/tools";
import {
  buildAgentRoutingContext,
  formatRouteRecommendation,
  recommendSeatForObjective,
} from "@/lib/agent-routing-context";
import {
  buildContentMissionApprovalPacket,
  buildContentMissionDossier,
  buildContentMissionFallbackPlan,
  buildContentMissionProtocolBrief,
  isContentMissionObjective,
} from "@/lib/content-mission";
import { buildPlatformAuthReadiness, inferPlatformRequirements } from "@/lib/platform-auth-readiness";
import type { AgentExecution, AgentEnvironmentConfig, AgentRole, Approval, Company, Cycle, Task, ToolCallRecord } from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";
import { callJson, callText, MODELS, MAX_TOKENS } from "@/lib/ai-client";
import { runSeatAgent, type SeatLoopResumeSeed } from "@/lib/seat-agent-loop";
import type { WorkRequest } from "@/lib/planner";
import { getSeatManifest } from "@/lib/seat-manifest";
import { SLOT_CONTRACTS } from "@/lib/agent-catalog";
import { routeToolsForStep } from "@/lib/semantic-router";
import { getDegradedTools } from "@/lib/tool-health-cache";
import { getRuntimeEvalOverrides } from "@/lib/runtime-eval-overrides";
import { emitJobEvent } from "@/lib/job-events";
import { buildCompanySkillPrelude, buildCustomSkillPrelude } from "@/lib/agent-skill-instructions";
import { getMcpAdaptersForCompany } from "@/lib/mcp-tool-adapter";
import { InMemorySkillDraftStore, type SkillDraftStore } from "@/lib/skill-foundry";
import { PrismaSkillDraftStore } from "@/lib/self-improvement/skill-draft-store.prisma";
import { foldPlaybook, renderPlaybookBlock } from "@/lib/self-improvement/company-playbook";
import { getCompanyPlaybookLog } from "@/lib/self-improvement/company-playbook-log";
import { formatPlanValidationErrors, validateOrchestrationPlan } from "@/lib/plan-validator";
import { buildGroundedSourceContext } from "@/lib/source-grounding";
import { selectRelevantDocuments } from "@/lib/source-coverage";
import { seatOutputSchemas } from "@/lib/seat-output-schemas";
import { logger } from "@/lib/logger";
import { callCriticJsonWithRepair, logCriticRepairTelemetry } from "@/lib/orchestrator-critic-repair";
import { getCompanyAutonomySettings } from "@/lib/autonomy-settings";

/**
 * Skill reuse (OpenSpace): inject a company's live distilled skills into the seat
 * prompt so agents follow proven procedures instead of re-deriving them. Behind a
 * flag, default OFF → prod behavior unchanged until the live skill store + trace
 * derivation (Slice 2) are validated end-to-end.
 */
const SKILL_INJECTION_ENABLED = process.env.SKILL_INJECTION_ENABLED === "1";

let liveSkillStore: SkillDraftStore | null = null;
function getLiveSkillStore(): SkillDraftStore {
  if (liveSkillStore) return liveSkillStore;
  // Prisma-backed when a DB is configured, else an (empty) in-memory store so
  // injection safely no-ops in DB-less dev/test.
  liveSkillStore = process.env.DATABASE_URL
    ? new PrismaSkillDraftStore()
    : new InMemorySkillDraftStore();
  return liveSkillStore;
}

const TOKEN_ESTIMATE_PER_STEP = 1500;
// ── Model config ──────────────────────────────────────────────────────────────
const PLANNER_MODEL    = process.env.PLANNER_MODEL    ?? MODELS.STRONG;
const SPECIALIST_MODEL = process.env.SPECIALIST_MODEL ?? MODELS.DEFAULT;
const CRITIC_MODEL     = process.env.CRITIC_MODEL     ?? MODELS.CRITIC;

export const agentRoles = [
  "ceo", "engineer", "growth", "content", "support",
  "finance", "analyst", "escalation", "sales",
] as const;

export function normalizePlannerAgentRole(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  for (const role of agentRoles) {
    if (normalized === role || normalized.split(" ").includes(role)) return role;
  }
  if (/\b(project manager|program manager|operator|operations lead|team lead|team leader|lead)\b/.test(normalized)) return "ceo";
  if (/\bresearch\b|\banalysis\b|\banalyst\b|\bdata\b|\bstrategy\b|\bstrategist\b/.test(normalized)) return "analyst";
  if (/\bengineering\b|\bdeveloper\b|\btechnical\b|\bcode\b/.test(normalized)) return "engineer";
  if (/\bmarketing\b|\bmarketer\b|\bacquisition\b|\bgo to market\b|\bgtm\b/.test(normalized)) return "growth";
  if (/\bcopy\b|\bcreative\b|\bwriting\b|\bwriter\b/.test(normalized)) return "content";
  if (/\bcustomer\b|\bsuccess\b|\bfaq\b|\bticket\b/.test(normalized)) return "support";
  if (/\bescalate\b|\bapproval\b|\brisk\b|\blegal\b|\bfounder\b/.test(normalized)) return "escalation";
  return normalized ? "analyst" : value;
}

export function normalizePlannerRiskLevel(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().trim();
  if (/\b(high|critical|severe)\b/.test(normalized)) return "high";
  if (/\b(medium|moderate|normal)\b/.test(normalized)) return "medium";
  if (/\b(low|minor|minimal)\b/.test(normalized)) return "low";
  return value;
}

export function normalizePlannerBoolean(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.toLowerCase().trim();
  if (/^(true|yes|y|1|required|approval required)$/.test(normalized)) return true;
  if (/^(false|no|n|0|none|not required|approval not required)$/.test(normalized)) return false;
  return value;
}

export function normalizePlannerStringList(value: unknown): unknown {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || /^(none|n\/a|na|no blockers?|no dependencies?)$/i.test(trimmed)) return [];
  return trimmed
    .split(/[\n;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const agentRoleSchema = z.preprocess(
  normalizePlannerAgentRole,
  z.enum(agentRoles),
);

const riskLevelSchema = z.preprocess(
  normalizePlannerRiskLevel,
  z.enum(["low", "medium", "high"]),
);

const booleanSchema = z.preprocess(normalizePlannerBoolean, z.boolean());
const stringListSchema = z.preprocess(normalizePlannerStringList, z.array(z.string()));

const stepSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  agentRole: agentRoleSchema,
  dependsOn: stringListSchema.default([]),
  expectedOutput: z.string(),
  riskLevel: riskLevelSchema,
  needsApproval: booleanSchema.default(false),
  spec: z.object({
    acceptance: stringListSchema.pipe(z.array(z.string().min(1)).min(1)),
    inputsFrom: stringListSchema.default([]),
  }).optional(),
});

const planSchema = z.object({
  objective: z.string(),
  reasoning: z.string(),
  steps: z.array(stepSchema).min(1).max(12),
  successCriteria: stringListSchema,
  blockers: stringListSchema.default([]),
});

// Critic JSON robustness (§ critic repair): coerce the safe, unambiguous type
// mismatches the critic model commonly emits — a boolean/number where a string
// is expected — instead of failing the whole verdict. `reason: true` becomes
// "true". Genuinely malformed output still falls through to the repair retry.
function coerceScalarToString(value: unknown): unknown {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return value;
}

const requiredStringSchema = z.preprocess(
  (value) => value == null ? "No supervisor reason provided." : coerceScalarToString(value),
  z.string(),
);

const optionalStringSchema = z.preprocess(
  (value) => value == null ? undefined : coerceScalarToString(value),
  z.string().optional(),
);

const rubricScoreSchema = z.preprocess(
  (value) => typeof value === "string" ? Number(value) : value,
  z.number().int().min(0).max(3),
);

const critiqueScoresSchema = z.object({
  completeness: rubricScoreSchema,
  correctness: rubricScoreSchema,
  safety: rubricScoreSchema,
  followsSpec: rubricScoreSchema,
});

const critiqueSchema = z.object({
  verdict: z.enum(["pass", "retry", "replan", "escalate"]),
  reason: requiredStringSchema,
  improvement: optionalStringSchema,
  scores: critiqueScoresSchema.optional(),
  scoreRationale: z.preprocess(
    (value) => value == null ? undefined : value,
    z.record(z.string(), z.string()).optional(),
  ),
});

type RawOrchestrationPlan = z.infer<typeof planSchema>;

export type OrchestrationStep = Omit<z.infer<typeof stepSchema>, "dependsOn" | "needsApproval"> & {
  dependsOn: string[];
  needsApproval: boolean;
};

export type OrchestrationPlan = Omit<RawOrchestrationPlan, "steps" | "blockers"> & {
  steps: OrchestrationStep[];
  blockers: string[];
};

export type OrchestrationCritique = z.infer<typeof critiqueSchema>;

/**
 * §1 P1-3 — structured handoffs. `previousOutputs[stepId] = raw string` is the
 * textbook MAST inter-agent misalignment vector. A completed step publishes a
 * VALIDATED handoff contract (typed summary + key points + artifact refs) and
 * dependent steps consume that, not prose.
 */
export const stepHandoffSchema = z.object({
  stepId: z.string(),
  seat: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  whatIDidNotDo: z.array(z.string()).default([]),
  artifactRefs: z.array(z.string()).default([]),
  contractVersion: z.literal("v1").default("v1"),
});

export type StepHandoff = z.infer<typeof stepHandoffSchema>;

function toStringItems(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.map(stringifyItem).filter(Boolean);
}

function trimHandoffItems(items: string[], limit = 6): string[] {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((item) => item.slice(0, 240));
}

function prefixedHandoffItems(prefix: string, value: unknown): string[] {
  return toStringItems(value).map((item) => `${prefix}${item}`);
}

export function buildStepHandoff(
  step: Pick<OrchestrationStep, "id" | "agentRole">,
  rawOutput: Record<string, unknown> | null,
  fallbackText: string,
): StepHandoff {
  const summary = typeof rawOutput?.summary === "string" && rawOutput.summary.trim()
    ? rawOutput.summary
    : fallbackText;
  const keyPoints = trimHandoffItems(toStringItems(rawOutput?.findings));
  const nextActions = trimHandoffItems([
    ...toStringItems(rawOutput?.recommendations),
    ...toStringItems(rawOutput?.recommendation),
  ]);
  const risks = trimHandoffItems([
    ...toStringItems(rawOutput?.riskNotes),
    ...toStringItems(rawOutput?.dataCaveats),
    ...prefixedHandoffItems("Assumption: ", rawOutput?.assumptions),
    ...prefixedHandoffItems("Approval needed: ", rawOutput?.approvalRequests),
  ]);
  const whatIDidNotDo = trimHandoffItems(toStringItems(rawOutput?.whatIDidNotDo));
  const artifactRefs = Array.isArray(rawOutput?.artifactRefs)
    ? rawOutput.artifactRefs
        .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
        .map((ref) => ref.trim())
        .slice(0, 8)
    : [];
  return stepHandoffSchema.parse({
    stepId: step.id,
    seat: step.agentRole,
    summary: summary.slice(0, 700),
    keyPoints,
    nextActions,
    risks,
    whatIDidNotDo,
    artifactRefs,
  });
}

/** Render one dependency for a downstream seat — validated contract when available, prose fallback otherwise. */
export function renderDependencyHandoff(
  depId: string,
  handoff: StepHandoff | undefined,
  prose: string | undefined,
): string {
  if (handoff) {
    return [
      `[${depId} · ${handoff.seat} · validated handoff ${handoff.contractVersion}]`,
      `SUMMARY: ${handoff.summary}`,
      handoff.keyPoints.length ? `KEY POINTS:\n${handoff.keyPoints.map((point) => `- ${point}`).join("\n")}` : "",
      handoff.nextActions.length ? `NEXT ACTIONS:\n${handoff.nextActions.map((action) => `- ${action}`).join("\n")}` : "",
      handoff.risks.length ? `RISKS:\n${handoff.risks.map((risk) => `- ${risk}`).join("\n")}` : "",
      handoff.whatIDidNotDo.length ? `NOT DONE:\n${handoff.whatIDidNotDo.map((item) => `- ${item}`).join("\n")}` : "",
      handoff.artifactRefs.length ? `ARTIFACTS: ${handoff.artifactRefs.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  }
  return `[${depId}]: ${prose?.slice(0, 1000) ?? "(missing)"}`;
}

export type SeatLoopResumeState = SeatLoopResumeSeed;

export type StepRecord = OrchestrationStep & {
  status: "pending" | "running" | "completed" | "failed" | "blocked" | "awaiting_approval";
  output?: string;
  /** Validated handoff contract dependents consume instead of prose (§1 P1-3). */
  handoff?: StepHandoff;
  critique?: OrchestrationCritique;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  tokens?: number;
  costCents?: number;
  toolCalls?: ToolCallRecord[];
  approvalId?: string;
  /** Mid-loop tool-use state persisted while awaiting founder approval. */
  seatLoopState?: SeatLoopResumeState;
  /** The queue Task created for this step — closed when the step finishes. */
  taskId?: string;
};

/** Thrown when a seat agent loop pauses for tool approval — not a step failure. */
export class SeatLoopAwaitingApprovalError extends Error {
  readonly seatLoopState: SeatLoopResumeState;
  readonly toolCalls: ToolCallRecord[];
  readonly tokens: number;
  readonly costCents: number;
  readonly model: string;

  constructor(input: {
    seatLoopState: SeatLoopResumeState;
    toolCalls: ToolCallRecord[];
    tokens: number;
    costCents: number;
    model: string;
  }) {
    super("seat loop paused for tool approval");
    this.name = "SeatLoopAwaitingApprovalError";
    this.seatLoopState = input.seatLoopState;
    this.toolCalls = input.toolCalls;
    this.tokens = input.tokens;
    this.costCents = input.costCents;
    this.model = input.model;
  }
}

function findLastToolCall(
  toolCalls: ToolCallRecord[],
  predicate: (record: ToolCallRecord) => boolean,
): ToolCallRecord | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const record = toolCalls[index];
    if (predicate(record)) return record;
  }
  return undefined;
}

/** Coerce a model field (string | string[] | object[]) into readable bullet text. */
function toTextList(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(stringifyItem).filter(Boolean).join("\n");
}

/** Render one item as text — never "[object Object]". */
function stringifyItem(item: unknown): string {
  if (item == null) return "";
  if (typeof item === "string") return item;
  if (typeof item !== "object") return String(item);
  const o = item as Record<string, unknown>;
  const preferred = [o.title, o.point, o.summary, o.text, o.detail, o.description, o.recommendation, o.finding, o.value]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (preferred.length) return preferred.join(" — ");
  try {
    return JSON.stringify(item);
  } catch {
    return "";
  }
}

export function normalizePlan(plan: RawOrchestrationPlan): OrchestrationPlan {
  return {
    ...plan,
    blockers: plan.blockers ?? [],
    steps: plan.steps.map((step) => ({
      ...step,
      dependsOn: step.dependsOn ?? [],
      needsApproval: step.needsApproval ?? false,
      spec: step.spec ?? buildStepSpec(step),
    })),
  };
}

export function isReadOnlyPlanObjective(objective: string): boolean {
  const text = objective.toLowerCase();
  if (/\b(do not|don't|dont|without)\s+(make changes|change|edit|modify|deploy|execute|run|send|publish|launch|merge|spend|write)\b/.test(text)) return true;
  if (/\b(plan only|read[- ]only|analysis only|do not make changes|no changes)\b/.test(text)) return true;
  if (/\b(create|prepare|draft|write)\b[^.]{0,80}\b(implementation plan|deployment plan|qa plan|test plan|checklist|audit|analysis|report)\b/.test(text)) return true;
  if (/\b(identify|list|rank|prioriti[sz]e|summari[sz]e|analy[sz]e|audit|assess|review)\b[^.]{0,120}\b(priority|priorities|risk|risks|metric|metrics|owner|owners|approval yes\/no|approval gates?)\b/.test(text)) return true;
  if (/\bfounder approval yes\/no\b|\bapproval yes\/no\b/.test(text)) return true;
  return false;
}

export function sanitizeReadOnlyApprovalGates(plan: OrchestrationPlan, founderObjective: string): OrchestrationPlan {
  if (!isReadOnlyPlanObjective(`${founderObjective}\n${plan.objective}`)) return plan;
  return {
    ...plan,
    steps: plan.steps.map((step) => ({ ...step, needsApproval: false })),
  };
}

function buildStepSpec(step: Pick<OrchestrationStep, "title" | "expectedOutput" | "dependsOn">) {
  return {
    acceptance: [`Expected output satisfied: ${step.expectedOutput || step.title}`],
    inputsFrom: step.dependsOn ?? [],
  };
}

export function repairOrchestrationPlanRoutes(plan: OrchestrationPlan): OrchestrationPlan {
  if (isReadOnlyPlanObjective(plan.objective)) return plan;
  const route = recommendSeatForObjective(plan.objective);
  if (route.role === "ceo" || plan.steps.some((step) => step.agentRole === route.role)) return plan;

  const steps = plan.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const lastIndex = steps.length - 1;
  let finalIndex = -1;
  for (let index = steps.length - 1; index > 0; index--) {
    const step = steps[index];
    if (step.agentRole === "ceo" && /consolidat|summar|final|surface|review/i.test(step.title)) {
      finalIndex = index;
      break;
    }
  }
  finalIndex = Math.max(0, finalIndex);
  const insertIndex = finalIndex > 0 ? finalIndex : lastIndex + 1;
  const prerequisite = steps[Math.max(0, insertIndex - 1)];
  const specialistId = nextStepId(steps);
  const specialist: OrchestrationStep = {
    id: specialistId,
    title: `Execute primary workstream with ${route.tool}`,
    rationale: "Planner returned a CEO-only graph; route repair assigns the actual work to the capable specialist.",
    agentRole: route.role,
    dependsOn: prerequisite ? [prerequisite.id] : [],
    expectedOutput: `Produce the requested deliverable using ${route.tool} when available, with concrete output and verification notes.`,
    riskLevel: "medium",
    needsApproval: /\b(publish|send|merge|deploy|spend|charge|refund|withdraw|delete)\b/i.test(plan.objective),
    spec: {
      acceptance: [`Produce the requested deliverable using ${route.tool} with verification notes.`],
      inputsFrom: prerequisite ? [prerequisite.id] : [],
    },
  };

  steps.splice(insertIndex, 0, specialist);
  const finalStep = steps[insertIndex + 1];
  if (finalStep && finalStep.agentRole === "ceo" && !finalStep.dependsOn.includes(specialistId)) {
    finalStep.dependsOn = [...finalStep.dependsOn, specialistId];
  }
  return { ...plan, steps };
}

function nextStepId(steps: OrchestrationStep[]): string {
  const max = steps.reduce((highest, step) => {
    const match = /^s(\d+)$/.exec(step.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  let id = `s${max + 1}`;
  while (steps.some((step) => step.id === id)) id = `s${Number(id.slice(1)) + 1}`;
  return id;
}

// callJson and callText are imported from lib/ai-client.ts.
// Local wrappers below adapt the shared interface (which throws) to the fallback
// pattern the orchestrator uses — callers can still pass a deterministic fallback
// but failures are now logged, not swallowed silently.

/** A stage label for operator-visible LLM failures. */
type LlmFailureStage = "planner" | "critic" | "consolidator";

/** Operator-visibility context — threads a company/run id so a real failure can
 *  surface as a job event. Optional everywhere so the no-key offline path and
 *  existing callers/tests are unaffected. */
type LlmVisibility = {
  stage: LlmFailureStage;
  companyId?: string;
  jobRunId?: string;
  recovery?: "fallback" | "escalate";
};

/**
 * The "OPENAI_API_KEY is not configured" error is the EXPECTED dev/test/offline
 * mode — the orchestrator silently falls back. Treat any error whose message
 * mentions "not configured" (case-insensitive) as the benign offline case;
 * everything else is a genuine failure an operator should see.
 */
function isNotConfiguredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not configured/i.test(message);
}

/**
 * Make a genuine LLM failure visible to the operator WITHOUT changing control
 * flow: log it, and (when we have a company/run id) emit a non-terminal job
 * event so the failure shows up in the run feed. The benign "not configured"
 * offline case stays completely silent here.
 */
function reportLlmFailure(err: unknown, model: string, visibility?: LlmVisibility): void {
  if (isNotConfiguredError(err)) return; // benign offline mode — stay silent
  const stage = visibility?.stage ?? "planner";
  const message = err instanceof Error ? err.message : String(err);
  console.error("orchestrator.llm_failure", { stage, model, error: message });
  if (visibility?.jobRunId) {
    const recovery = visibility.recovery === "escalate"
      ? "escalating for human review"
      : "using fallback";
    emitJobEvent({
      jobRunId: visibility.jobRunId,
      companyId: visibility.companyId,
      status: "step",
      summary: `⚠ ${stage} LLM call failed (${model}): ${message} — ${recovery}`,
      at: nowIso(),
      step: { phase: "agent_retry", label: `${stage} LLM failure — ${recovery}` },
    });
  }
}

async function callJsonWithFallback<T>(
  model: string,
  system: string,
  user: string,
  schema: z.ZodTypeAny,
  fallback: T,
  visibility?: LlmVisibility,
): Promise<T> {
  try {
    const result = await callJson<T>(model, system, user, schema, MAX_TOKENS.PLANNING, {
      createCompletion: getRuntimeEvalOverrides()?.orchestration?.createCompletion,
    });
    return result.data;
  } catch (err) {
    reportLlmFailure(err, model, visibility);
    return fallback;
  }
}

async function callTextWithFallback(
  model: string,
  system: string,
  user: string,
  fallback: string,
  visibility?: LlmVisibility,
) {
  try {
    const result = await callText(model, system, user, MAX_TOKENS.PROSE);
    return { text: result.text, model, tokens: result.tokens };
  } catch (err) {
    reportLlmFailure(err, model, visibility);
    return { text: fallback, model: "fallback", tokens: 0 };
  }
}

/** Specialist seats engaged on a full autonomous company run (CEO bookends). */
const FULL_TEAM_SEATS: AgentRole[] = [
  "engineer", "growth", "content", "support", "analyst", "finance", "sales",
];

/**
 * True for cross-functional planning/audit/prioritization objectives that
 * must engage multiple specialist seats (Fix Plan Slice 1 — tester evidence:
 * "top 5 priorities" audits ran with only ceo+escalation).
 */
export function isBroadPlanningObjective(objective: string): boolean {
  const text = (objective ?? "").toLowerCase();
  if (/\b(top\s+\d+\s+priorit|priorities for the next|prioriti[sz]e (our|the) (work|roadmap|backlog))\b/.test(text)) return true;
  if (/\b(audit|review|assess)\b/.test(text) && /\b(company|business|product|roadmap|operations|everything|overall)\b/.test(text)) return true;
  if (/\b(7|seven|30|ninety|90)[- ]day (plan|campaign|roadmap)\b/.test(text)) return true;
  if (/\bacross\b/.test(text) && /\b(product|growth|support|finance|engineering|marketing)\b/.test(text)) return true;
  return false;
}

export async function generateOrchestrationPlan(
  company: Company,
  objective: string,
  memory: string,
  options?: { fullTeam?: boolean; runId?: string; operatingState?: string },
): Promise<OrchestrationPlan> {
  const fullTeam = options?.fullTeam ?? false;
  // RC1 fix (Fix Plan Slice 2): the planner sees which required sources exist
  // and which are missing before decomposing the objective. Best-effort.
  const planningDocs = await store.listDocuments(company.id).catch(() => []);
  const sourceContext = await buildGroundedSourceContext({
    companyId: company.id,
    query: [objective, memory].filter(Boolean).join("\n"),
    documents: planningDocs,
  });
  const prompts = buildOrchestrationPlanningPrompts(company, objective, memory, {
    fullTeam,
    operatingState: options?.operatingState,
    sourceCoverage: sourceContext.sourceCoverage,
    sourceDocuments: sourceContext.sourceDocuments,
  });
  const route = recommendSeatForObjective(objective);
  const fallbackNeedsApproval = /\b(publish|send|merge|deploy|spend|charge|refund|withdraw|delete)\b/i.test(objective);
  const fallbackPrimaryRole = route.role === "ceo" ? "engineer" : route.role;
  const contentMission = isContentMissionObjective(objective);

  const fallback: OrchestrationPlan = contentMission
    ? buildContentMissionFallbackPlan(objective)
    : fullTeam
    ? buildFullTeamFallbackPlan(objective)
    : isReadOnlyPlanObjective(objective)
    ? buildReadOnlyAnalysisFallbackPlan(objective)
    : buildStandardFallbackPlan(objective, route.tool, fallbackPrimaryRole, fallbackNeedsApproval);

  const rawPlan = await callJsonWithFallback<RawOrchestrationPlan>(
    PLANNER_MODEL,
    prompts.system,
    prompts.user,
    planSchema,
    fallback,
    { stage: "planner", companyId: company.id, jobRunId: options?.runId },
  );
  const candidate = sanitizeReadOnlyApprovalGates(
    repairOrchestrationPlanRoutes(sanitizeReadOnlyApprovalGates(normalizePlan(rawPlan), objective)),
    objective,
  );
  if (!orchestrationPlanValidatorEnabled()) return candidate;

  const validation = validateOrchestrationPlan(candidate, {
    seatRoster: Object.keys(seatOutputSchemas) as AgentRole[],
    budgetCapCents: getCompanyBudgetCapCents(company),
  });
  if (validation.ok) return candidate;

  logger.warn(
    { objective, errors: validation.errors },
    "[orchestrator] generated plan failed semantic validation; using deterministic fallback"
  );
  const fallbackPlan = sanitizeReadOnlyApprovalGates(
    repairOrchestrationPlanRoutes(sanitizeReadOnlyApprovalGates(normalizePlan(fallback), objective)),
    objective,
  );
  const fallbackValidation = validateOrchestrationPlan(fallbackPlan, {
    seatRoster: Object.keys(seatOutputSchemas) as AgentRole[],
    budgetCapCents: getCompanyBudgetCapCents(company),
  });
  if (fallbackValidation.ok) return fallbackPlan;
  throw new Error(`Invalid deterministic fallback plan: ${formatPlanValidationErrors(fallbackValidation.errors)}`);
}

function orchestrationPlanValidatorEnabled(): boolean {
  return process.env.ORCHESTRATION_PLAN_VALIDATOR_ENABLED === "1";
}

function getCompanyBudgetCapCents(company: Company): number {
  const budget = (company as { budgetCents?: unknown }).budgetCents;
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? budget
    : Number.MAX_SAFE_INTEGER;
}

function buildStandardFallbackPlan(
  objective: string,
  tool: string,
  fallbackPrimaryRole: AgentRole,
  fallbackNeedsApproval: boolean,
): OrchestrationPlan {
  const steps: OrchestrationPlan["steps"] = [
    {
      id: "s1",
      title: "Scope objective and identify the leverage points",
      rationale: "Establish what done looks like.",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "Crisp 2-line success definition + 1 risk.",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: `Execute primary workstream with ${tool}`,
      rationale: "Ship the actual deliverable with the smallest capable specialist.",
      agentRole: fallbackPrimaryRole,
      dependsOn: ["s1"],
      expectedOutput: `First-pass deliverable using ${tool} when available, with notes and approval needs.`,
      riskLevel: "medium",
      needsApproval: fallbackNeedsApproval,
    },
  ];

  if (fallbackNeedsApproval) {
    steps.push({
      id: "s3",
      title: "Prepare approval gate for irreversible work",
      rationale: "External sends, spend, deploys, and destructive actions need founder review before execution.",
      agentRole: "escalation",
      dependsOn: ["s2"],
      expectedOutput: "Approval card with risk, reversibility, preview, and recommended decision.",
      riskLevel: "high",
      needsApproval: false,
    });
  }

  steps.push({
    id: fallbackNeedsApproval ? "s4" : "s3",
    title: "Consolidate and surface the final artifact",
    rationale: "Wrap up with a tight summary the founder can act on.",
    agentRole: "ceo",
    dependsOn: [fallbackNeedsApproval ? "s3" : "s2"],
    expectedOutput: "Single-screen summary + next-action.",
    riskLevel: "low",
    needsApproval: false,
  });

  return {
    objective,
    reasoning: "LLM unavailable — using deterministic fallback plan.",
    steps,
    successCriteria: ["Deliverable produced", "No unapproved external sends"],
    blockers: [],
  };
}

function buildReadOnlyAnalysisFallbackPlan(objective: string): OrchestrationPlan {
  const steps: OrchestrationStep[] = [
    {
      id: "s1",
      title: "Analyze source evidence and current state",
      rationale: "Read-only planning starts by grounding the answer in available company context.",
      agentRole: "analyst",
      dependsOn: [],
      expectedOutput: `Summarize the evidence relevant to "${objective}" with citations, available/missing source coverage, and no tool execution claims.`,
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Assess technical and operational risks",
      rationale: "Priorities need implementation risk and owner clarity, not an external action.",
      agentRole: "engineer",
      dependsOn: ["s1"],
      expectedOutput: `Identify technical/operational risks, likely owner seats, and success metrics for "${objective}".`,
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Assess growth and customer impact",
      rationale: "Priority planning should account for customer and go-to-market impact.",
      agentRole: "growth",
      dependsOn: ["s1"],
      expectedOutput: `Rank customer/growth impact and approval/review needs for "${objective}" without launching or publishing anything.`,
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s4",
      title: "Consolidate read-only recommendation",
      rationale: "The CEO synthesizes specialist analysis into the requested founder-facing answer.",
      agentRole: "ceo",
      dependsOn: ["s1", "s2", "s3"],
      expectedOutput: `Deliver the requested read-only output for "${objective}" with owner, expected output, success metric, risk, and founder approval yes/no where requested.`,
      riskLevel: "low",
      needsApproval: false,
    },
  ];
  return {
    objective,
    reasoning: "Read-only analysis fallback plan.",
    steps,
    successCriteria: ["Requested analysis is answered directly", "No unrequested tools, deploys, publishes, or writes are performed"],
    blockers: [],
  };
}

/**
 * Deterministic full-company plan: every specialist seat gets one substantive
 * step (CEO scopes first, CEO consolidates last). Used as the autonomous-mode
 * fallback and as the shape the planner is told to produce.
 */
function buildFullTeamFallbackPlan(objective: string): OrchestrationPlan {
  // Each seat does its DOMAIN'S part of the actual objective — not generic
  // company busywork. The objective is woven into every step so a request like
  // "analyze SpaceX stocks and make a slideshow" routes the financial analysis to
  // finance/analyst and the slide deck to content/engineer, instead of every seat
  // defaulting to boilerplate ops work.
  const seatBrief: Record<AgentRole, string> = {
    ceo: "",
    engineer: "Do the technical/build part of the goal — scaffold or produce any app, script, data pipeline, or document generation it needs.",
    growth: "Do the growth/distribution part of the goal — positioning, channels, or how to get this in front of the right audience (only if relevant).",
    content: "Produce the written/visual deliverable the goal needs — report copy, slide content, narrative — labeled DRAFT.",
    support: "Do the customer-facing part of the goal — only if the goal touches customers; otherwise say it's out of scope in one line.",
    analyst: "Do the data/research analysis the goal needs — gather the key numbers, trends, comparisons, and findings.",
    finance: "Do the financial analysis the goal needs — figures, valuations, risk, runway, or unit economics relevant to the goal.",
    sales: "Do the pipeline/prospect part of the goal — only if the goal involves selling or outreach; otherwise say it's out of scope in one line.",
    escalation: "",
  };
  const steps: OrchestrationStep[] = [
    {
      id: "s1",
      title: `Scope the goal: ${objective.slice(0, 80)}`,
      rationale: "CEO breaks the founder's goal into what each specialist should deliver.",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: `Restate the goal in 2 lines and assign each seat the specific part of "${objective}" it should deliver.`,
      riskLevel: "low",
      needsApproval: false,
    },
    ...FULL_TEAM_SEATS.map((seat, i): OrchestrationStep => ({
      id: `s${i + 2}`,
      title: `${seat}: deliver your part of the goal`,
      rationale: `Engage the ${seat} seat on the founder's actual goal.`,
      agentRole: seat,
      dependsOn: ["s1"],
      expectedOutput: `${seatBrief[seat] || `Deliver the ${seat} seat's part of the goal`} Goal: "${objective}".`,
      riskLevel: "medium",
      needsApproval: false,
    })),
    {
      id: "s9",
      title: "Consolidate every seat's work into a founder report",
      rationale: "CEO synthesizes all specialist output into one decision-ready brief.",
      agentRole: "ceo",
      dependsOn: FULL_TEAM_SEATS.map((_, i) => `s${i + 2}`),
      expectedOutput: `Synthesize every seat's output into one report that directly answers the goal "${objective}": TL;DR, the actual deliverable/findings, risks, and the single next action.`,
      riskLevel: "low",
      needsApproval: false,
    },
  ];
  return {
    objective,
    reasoning: "Full autonomous company run — every seat does its part of the founder's goal.",
    steps,
    successCriteria: [`The goal "${objective.slice(0, 60)}" is directly addressed`, "A consolidated founder report with the deliverable and next actions"],
    blockers: [],
  };
}

export function buildOrchestrationPlanningPrompts(
  company: Company,
  objective: string,
  memory: string,
  options?: { fullTeam?: boolean; operatingState?: string; sourceCoverage?: string; sourceDocuments?: string },
): { system: string; user: string } {
  const fullTeam = options?.fullTeam ?? false;
  const route = recommendSeatForObjective(objective);
  const contentMissionBrief = buildContentMissionProtocolBrief(objective);
  // RC1/RC2 (Fix Plan Slice 1): broad planning/audit/prioritization objectives
  // were routed to only ceo+escalation, producing thin audits. Force the
  // relevant specialist seats into the plan for cross-functional objectives.
  const broadPlanning = isBroadPlanningObjective(objective);
  const teamRule = fullTeam
    ? "  4. FULL AUTONOMOUS COMPANY RUN: engage EVERY relevant specialist seat (engineer, growth, content, support, analyst, finance, sales) with at least one substantive step doing real work in its domain, then a final ceo step that consolidates everything. Use up to 12 steps."
    : broadPlanning
    ? "  4. BROAD PLANNING/AUDIT OBJECTIVE: this objective spans multiple functions. Engage at least three specialist seats (e.g. analyst, engineer, growth, finance — whichever domains the objective touches) with one substantive step each, then a final ceo step that consolidates. Never plan only ceo/escalation steps for an objective like this. Use 4–10 steps."
    : "  4. Keep step count tight: 3–8 for most objectives, max 12.";
  const system = [
    "You are Trent's chief orchestrator — the long-horizon planner that decomposes an objective into a multi-agent task graph.",
    "You operate like Devin: think before doing, identify dependencies, predict blockers, and assign each step to the right specialist.",
    buildAgentRoutingContext(company.id),
    formatRouteRecommendation("objective", route),
    "Plan rules:",
    "  1. Steps must form a DAG — every dependsOn id must reference an earlier step id.",
    "  2. Always include a final ceo step that consolidates the output.",
    "  3. Mark needsApproval=true for any external sends, public posts, paid actions, code merges.",
    teamRule,
    "  5. Each step must include spec: { acceptance: string[], inputsFrom: string[] }. acceptance must contain at least one concrete completion criterion; inputsFrom lists upstream dependsOn ids that feed the step.",
    "  6. successCriteria must be measurable.",
    contentMissionBrief,
    "Output strict JSON matching the schema.",
  ].filter(Boolean).join("\n");

  const user = [
    `Company: ${company.name}`,
    `Vision: ${company.brief.vision || "—"}`,
    `Goal: ${company.brief.goals || "—"}`,
    `ICP: ${company.brief.icp || "—"}`,
    "",
    `Past company memory (relevance-ranked):\n${memory || "(no prior memory)"}`,
    "",
    // §1 P0-2 — the planner sees the REAL operating state (open/stale tasks,
    // pending approvals, budget vs burn, last cycle), never plans from amnesia.
    ...(options?.operatingState ? ["CURRENT OPERATING STATE:", options.operatingState, ""] : []),
    // RC1 (Slice 2) — required vs missing sources. The plan must state
    // coverage and must never claim to have audited a missing source.
    ...(options?.sourceCoverage
      ? [options.sourceCoverage, "The final consolidated output MUST include this source coverage (available vs missing).", ""]
      : []),
    ...(options?.sourceDocuments
      ? [options.sourceDocuments, "Use these source documents/wiki chunks when planning evidence-gathering and cite their ids in downstream step expectations.", ""]
      : []),
    `Objective: ${objective}`,
    "",
    "Respond as JSON: { objective, reasoning, steps:[{id,title,rationale,agentRole,dependsOn,expectedOutput,riskLevel,needsApproval,spec:{acceptance:[],inputsFrom:[]}}], successCriteria:[], blockers:[] }",
  ].join("\n");
  return { system, user };
}

export function criticRubricEnabled(): boolean {
  return process.env.CRITIC_RUBRIC_ENABLED === "1";
}

const RUBRIC_DIMENSIONS = [
  "completeness - 0: absent or off-topic; 1: partial, major gaps; 2: adequate, covers the expected output; 3: exemplary, nothing material missing.",
  "correctness - 0: factually wrong or broken; 1: notable errors; 2: sound with minor nits; 3: verifiably correct.",
  "safety - 0: violates an approval gate or leaks secrets; 1: risky claims or ungated side effects; 2: respects gates with minor ambiguity; 3: clearly safe and gate-aware.",
  "followsSpec - 0: ignores the acceptance checklist; 1: misses most bullets; 2: meets the checklist; 3: meets it with evidence cited per bullet.",
];

function rubricChecklist(step: OrchestrationStep): string[] {
  const acceptance = step.spec?.acceptance?.length
    ? step.spec.acceptance
    : [`Expected output satisfied: ${step.expectedOutput || step.title}`];
  const seatMetrics = SLOT_CONTRACTS[step.agentRole]?.successMetrics ?? [];
  return [
    "Acceptance checklist (drives followsSpec):",
    ...acceptance.map((bullet) => `- ${bullet}`),
    ...(seatMetrics.length
      ? [
          `Seat quality bar for ${step.agentRole} (from its slot contract - weigh into completeness/correctness):`,
          ...seatMetrics.map((metric) => `- ${metric}`),
        ]
      : []),
  ];
}

function applyRubricGuard(critique: OrchestrationCritique): OrchestrationCritique {
  const scores = critique.scores;
  if (!scores) return critique;
  let guarded = critique.verdict;
  if (scores.safety < 2) guarded = "escalate";
  else if (scores.followsSpec < 2) guarded = critique.verdict === "replan" ? "replan" : "retry";
  else if (critique.verdict === "pass" && (scores.completeness < 2 || scores.correctness < 2)) guarded = "retry";
  if (guarded === critique.verdict) return critique;
  return { ...critique, verdict: guarded, reason: `[rubric guard: scores require ${guarded}] ${critique.reason}` };
}

export async function critiqueStepOutput(
  step: OrchestrationStep,
  output: string,
  visibility?: { companyId?: string; runId?: string },
  upstreamHandoffs?: StepHandoff[],
): Promise<OrchestrationCritique> {
  const rubricMode = criticRubricEnabled();
  const upstreamAsks = (upstreamHandoffs ?? [])
    .flatMap((handoff) => handoff.nextActions.map((action) => `- ${handoff.seat}: ${action}`));
  const system = rubricMode
    ? [
        "You are Trent's quality supervisor. Review the output of an agent step against its expected output.",
        "First score each rubric dimension independently on 0-3 using these anchors:",
        ...RUBRIC_DIMENSIONS.map((line) => `- ${line}`),
        "Only after scoring, derive the verdict. Scores are authoritative: safety<2 forces 'escalate', followsSpec<2 forces 'retry' (or 'replan' if the plan shape is wrong), and a 'pass' requires completeness>=2 and correctness>=2 - a guard enforces this in code.",
        "Return JSON: { scores: { completeness, correctness, safety, followsSpec }, scoreRationale: { <dimension>: <one line> }, verdict: 'pass'|'retry'|'replan'|'escalate', reason, improvement? }.",
        "Use 'pass' for sufficient work, 'retry' for fixable gaps in the same step, 'replan' when the plan shape is wrong and remaining steps must change, 'escalate' for unsafe/uncertain outputs needing founder review.",
        "Grounding rules (RC1): if the output claims required documents were unavailable while the step context contains a SOURCE COVERAGE block listing them as Available, score followsSpec at most 1. If the output claims to have audited/read a source that coverage lists as Missing, score correctness at most 1. Document-grounded claims with zero citations to source doc ids are a gap, not a pass.",
        "Be terse and direct.",
      ].join("\n")
    : [
        "You are Trent's quality supervisor. Review the output of an agent step against its expected output.",
        "Return JSON: { verdict: 'pass'|'retry'|'replan'|'escalate', reason, improvement? }.",
        "Use 'pass' for sufficient work, 'retry' for fixable gaps in the same step, 'replan' when the plan shape is wrong and remaining steps must change, 'escalate' for unsafe/uncertain outputs needing founder review.",
        "Grounding rules (RC1): if the output claims required documents were unavailable while the step context contains a SOURCE COVERAGE block listing them as Available, return 'retry'. If the output claims to have audited/read a source that coverage lists as Missing, return 'retry'. Document-grounded claims with zero citations to source doc ids are a gap, not a pass.",
        "Be terse and direct.",
      ].join("\n");
  const user = [
    `Step: ${step.title} (role=${step.agentRole}, risk=${step.riskLevel})`,
    `Expected: ${step.expectedOutput}`,
    ...(rubricMode ? ["", ...rubricChecklist(step)] : []),
    upstreamAsks.length
      ? `\nUpstream agents asked this step to act on these - flag if the output ignored them${rubricMode ? " (counts against followsSpec)" : " (return 'retry')"}:\n${upstreamAsks.join("\n")}`
      : "",
    "",
    `Output:\n${output.slice(0, 2400)}`,
  ].join("\n");

  try {
    // Robust parse: simple type mismatches are coerced by the schema; anything
    // it can't fix gets ONE repair retry with telemetry. A real infra failure is
    // rethrown to the catch below so the existing degradation path is preserved.
    const result = await callCriticJsonWithRepair<OrchestrationCritique>({
      model: CRITIC_MODEL,
      system,
      user,
      schema: critiqueSchema,
      maxTokens: MAX_TOKENS.PLANNING,
      createCompletion: getRuntimeEvalOverrides()?.orchestration?.createCompletion,
      onTelemetry: logCriticRepairTelemetry,
      meta: { companyId: visibility?.companyId, runId: visibility?.runId },
    });
    return applyRubricGuard(result.data);
  } catch (err) {
    if (isNotConfiguredError(err)) {
      return { verdict: "pass", reason: "supervisor offline — auto-pass." };
    }
    reportLlmFailure(err, CRITIC_MODEL, {
      stage: "critic",
      companyId: visibility?.companyId,
      jobRunId: visibility?.runId,
      recovery: "escalate",
    });
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: "escalate",
      reason: `critic LLM call failed: ${message}`,
      improvement: "Require human review before considering this step complete.",
    };
  }
}

export function buildConsolidationUserPrompt(
  plan: OrchestrationPlan,
  steps: StepRecord[],
  contentApprovalPacket?: string | null,
): string {
  const completed = steps.filter((step) => step.status === "completed");
  const failed = steps.filter((step) => step.status === "failed");
  const seatRisks = completed.flatMap((step) =>
    (step.handoff?.risks ?? []).map((risk) => `- ${step.agentRole}: ${risk}`),
  );
  const seatNotDone = completed.flatMap((step) =>
    (step.handoff?.whatIDidNotDo ?? []).map((item) => `- ${step.agentRole}: ${item}`),
  );
  return [
    `Objective: ${plan.objective}`,
    `Success criteria: ${plan.successCriteria.join("; ")}`,
    "",
    `Completed (${completed.length}):`,
    ...completed.map((step) => `- ${step.title}: ${(step.handoff?.summary ?? step.output ?? "").slice(0, 300)}`),
    "",
    seatRisks.length ? `Seat-reported risks:\n${seatRisks.join("\n")}` : "",
    seatNotDone.length ? `Explicitly NOT done (close the loop or flag):\n${seatNotDone.join("\n")}` : "",
    failed.length ? `Failed (${failed.length}):\n${failed.map((step) => `- ${step.title}`).join("\n")}` : "",
    contentApprovalPacket ? `\nContent/social/ads approval packet to preserve exactly:\n${contentApprovalPacket}` : "",
  ].filter(Boolean).join("\n");
}

export async function consolidateRun(
  plan: OrchestrationPlan,
  steps: StepRecord[],
  visibility?: { companyId?: string; runId?: string },
): Promise<string> {
  const contentApprovalPacket = buildContentMissionApprovalPacket(plan, steps);
  const system = [
    "You are the consolidator. Write a final brief that a founder can read in 60 seconds and act on.",
    "Format:",
    "  TL;DR — one sentence.",
    "  WHAT SHIPPED — 2-4 bullets.",
    "  RISKS / BLOCKERS — bullets, or 'none'.",
    "  ↗ NEXT ACTION — a single direct ask.",
  ].join("\n");
  const user = buildConsolidationUserPrompt(plan, steps, contentApprovalPacket);

  const result = await callTextWithFallback(
    SPECIALIST_MODEL,
    system,
    user,
    contentApprovalPacket || "Run completed — see step outputs.",
    { stage: "consolidator", companyId: visibility?.companyId, jobRunId: visibility?.runId },
  );
  if (!contentApprovalPacket) return result.text;
  return result.text.trim() === contentApprovalPacket.trim()
    ? contentApprovalPacket
    : `${contentApprovalPacket}\n\n${result.text}`;
}

export async function saveCycleForRun(
  companyId: string,
  runId: string,
  objective: string,
  trigger: "manual" | "scheduled" = "manual",
  kind: Cycle["kind"] = "ad_hoc_dag",
): Promise<string> {
  const cycle: Cycle = {
    id: runId,
    companyId,
    trigger,
    kind,
    status: "running",
    phases: ["plan", "execute", "consolidate"],
    summary: objective.slice(0, 200),
    startedAt: nowIso(),
  };
  await store.saveCycle(cycle);
  return cycle.id;
}

export async function createTaskForStep(
  companyId: string,
  runId: string,
  step: OrchestrationStep,
): Promise<Task> {
  return store.createTask({
    companyId,
    title: step.title,
    prompt: step.expectedOutput,
    status: step.needsApproval ? "waiting_approval" : "queued",
    priority: step.riskLevel === "high" ? "high" : "medium",
    agentRole: step.agentRole,
    tags: ["orchestration", runId, step.id],
  });
}

export async function createApprovalForStep(
  company: Company,
  runId: string,
  step: OrchestrationStep,
): Promise<Approval> {
  const expiryHours = getApprovalExpiryHours("", company.approvalExpiryOverrides);
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
  return store.createApproval({
    companyId: company.id,
    action: step.title,
    reason: step.rationale,
    previewContent: step.expectedOutput,
    previewKind: "generic",
    expiresAt,
    toolName: `orchestration:${runId}:${step.id}`,
  });
}

export async function createApprovalForSeatTool(
  company: Company,
  runId: string,
  step: OrchestrationStep,
  pendingTool: { adapter: string; action: string; summary: string },
): Promise<Approval> {
  const expiryHours = getApprovalExpiryHours(pendingTool.adapter, company.approvalExpiryOverrides);
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();
  return store.createApproval({
    companyId: company.id,
    action: `${step.title}: ${pendingTool.adapter}`,
    reason: `Seat ${step.agentRole} requested tool action requiring approval: ${pendingTool.action}`,
    previewContent: pendingTool.summary,
    previewKind: "generic",
    expiresAt,
    toolName: `orchestration:${runId}:${step.id}:tool:${pendingTool.adapter}`,
  });
}

export async function toolsForStep(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
  k = 3,
): Promise<ToolAdapter[]> {
  return routeToolsForStep(stepText, environment, k);
}

export async function toolForStep(
  stepText: string,
  environment: Pick<AgentEnvironmentConfig, "tools">,
): Promise<ToolAdapter | undefined> {
  const tools = await toolsForStep(stepText, environment, 1);
  return tools[0];
}

export type RuntimeStep = {
  id: string;
  title: string;
  agentRole: AgentRole;
  rationale: string;
  expectedOutput: string;
  riskLevel: string;
  dependsOn: string[];
  spec?: OrchestrationStep["spec"];
  needsApproval?: boolean;
};

export type StepExecutionInput = {
  step: RuntimeStep;
  company: Company;
  previousOutputs: Record<string, string>;
  /** Validated upstream handoff contracts keyed by step id (§1 P1-3). */
  previousHandoffs?: Record<string, StepHandoff>;
  cycleId?: string;
  approvalGranted?: boolean;
  /** Prior mid-loop tool history when resuming after durable tool approval. */
  resumeSeed?: SeatLoopResumeState;
  /** The overall run objective — injected so every seat does work that serves it. */
  objective?: string;
};

export type StepExecutionResult = {
  output: string;
  /** Validated handoff contract published for dependent steps (§1 P1-3). */
  handoff: StepHandoff;
  model: string;
  tokens: number;
  costCents: number;
  toolCalls: ToolCallRecord[];
  /** The seat loop exhausted tool-use turns without producing a final answer. */
  maxStepsReached?: boolean;
  execution: AgentExecution;
  /** Work the agent is requesting from other agents — routed by the orchestrator. */
  workRequests: WorkRequest[];
};

/**
 * Fetch live company data relevant to the seat's declared contextNeeds so agents
 * are not running blind. Each fetch is guarded by the manifest's contextNeeds to
 * avoid unnecessary DB round-trips.
 */
async function buildLiveContext(
  companyId: string,
  company: Company,
  role: AgentRole,
  missionText = "",
): Promise<Record<string, unknown>> {
  const needs = new Set(getSeatManifest(role).contextNeeds);
  const ctx: Record<string, unknown> = {};

  // Company metrics and budget are already on the Company object
  if (needs.has("metrics") || needs.has("dataFreshness")) ctx.metrics = company.metrics;
  if (needs.has("budget") || needs.has("billingState")) {
    ctx.budget = { totalCents: company.budgetCents, weeklyCents: company.weeklyBudgetCents ?? null };
  }
  if (needs.has("contentMission")) {
    const missionDossier = buildContentMissionDossier(missionText);
    if (missionDossier) ctx.contentMission = missionDossier;
  }

  // Parallel DB fetches — only what each seat actually needs
  const needsTasks     = needs.has("activeTasks") || needs.has("taskSpec");
  const needsApprovals = needs.has("approvals") || needs.has("approvalPolicy");
  const needsUsage     = needs.has("usage") || needs.has("billingState");
  const needsReports   = needs.has("reports") || needs.has("metrics") || needs.has("dataFreshness");
  const needsDocs      = needs.has("productDocs") || needs.has("tonePolicy");
  const needsPlatform  = needs.has("platformReadiness");

  // RC1 fix (Fix Plan Slice 2): documents are ALWAYS fetched so source
  // retrieval + coverage reach every seat, not only seats declaring
  // productDocs/tonePolicy. Best-effort: a store failure degrades to null.
  const [tasks, approvals, usage, reports, docs, socialAccounts, marketingAccounts] = await Promise.all([
    needsTasks     ? store.listTasks(companyId)     : Promise.resolve(null),
    needsApprovals ? store.listApprovals(companyId) : Promise.resolve(null),
    needsUsage     ? store.listUsage(companyId)     : Promise.resolve(null),
    needsReports   ? store.listReports(companyId)   : Promise.resolve(null),
    store.listDocuments(companyId).catch(() => null),
    needsPlatform  ? store.listSocialAccounts(companyId) : Promise.resolve(null),
    needsPlatform  ? store.listMarketingAccounts(companyId) : Promise.resolve(null),
  ]);

  if (tasks) {
    ctx.activeTasks = tasks
      .filter(t => t.status !== "completed" && t.status !== "failed")
      .slice(0, 8)
      .map(t => ({ title: t.title, status: t.status, agentRole: t.agentRole, priority: t.priority }));
  }
  if (approvals) {
    ctx.pendingApprovals = approvals
      .filter(a => a.status === "pending")
      .slice(0, 5)
      .map(a => ({ action: a.action, reason: a.reason, expiresAt: a.expiresAt }));
  }
  if (usage) {
    const totalSpentCents = usage.reduce((s, u) => s + (u.amountCents ?? 0), 0);
    ctx.usageSummary = {
      totalSpentCents,
      recentItems: usage.slice(0, 5).map(u => ({ description: u.description, amountCents: u.amountCents })),
    };
  }
  if (reports) {
    ctx.recentReports = reports
      .slice(0, 3)
      .map(r => ({ title: r.title, type: r.type, findings: r.findings.slice(0, 3), recommendations: r.recommendations.slice(0, 3) }));
  }
  if (docs) {
    // Relevance-rank recalled memory against the current mission instead of
    // taking the most-recent few. Long-horizon recall should surface the past
    // cycles/learnings most relevant to THIS objective (Viktor-style context),
    // not just whatever happened last. selectRelevantDocuments degrades to
    // recency order when the mission has no usable keywords, so behaviour is
    // unchanged for objective-less runs.
    const episodic = selectRelevantDocuments(
      missionText,
      docs.filter(d => d.memoryTier === "episodic"),
      3,
    ).map(d => ({ title: d.title, summary: d.content.slice(0, 400) }));
    if (episodic.length > 0) ctx.recentMemory = episodic;
    if (needsDocs) {
      const productDocs = selectRelevantDocuments(
        missionText,
        docs.filter(d => d.type === "brief" || d.type === "weekly_report"),
        3,
      ).map(d => ({ title: d.title, summary: d.content.slice(0, 500) }));
      if (productDocs.length > 0) ctx.productDocs = productDocs;
    }
  }

  // RC1 + competitive upgrade: every seat gets relevance-ranked source
  // documents from company docs/uploads plus semantic wiki chunks. The same
  // coverage contract drives critic grounding, so wiki pages can satisfy
  // required-source needs without a separate prompt vocabulary.
  const sourceContext = await buildGroundedSourceContext({
    companyId,
    query: missionText || "",
    documents: (docs ?? []).map(d => ({ id: d.id, title: d.title, content: d.content, type: d.type })),
  });
  if (sourceContext.sourceDocuments) ctx.sourceDocuments = sourceContext.sourceDocuments;
  if (sourceContext.sourceCoverage) ctx.sourceCoverage = sourceContext.sourceCoverage;

  if (needsPlatform && socialAccounts && marketingAccounts) {
    const inferred = inferPlatformRequirements(missionText);
    const readiness = buildPlatformAuthReadiness({
      socialAccounts,
      marketingAccounts,
      ...inferred,
    });
    ctx.platformReadiness = {
      ...readiness,
      ...inferred,
      socialAccounts: socialAccounts.map((account) => ({
        platform: account.platform,
        status: account.status,
        externalHandle: account.externalHandle,
        scopes: account.scopes,
        hasCredentials: Boolean(account.credentialsRef),
        autoPublishEnabled: account.autoPublishEnabled,
      })),
      marketingAccounts: marketingAccounts.map((account) => ({
        platform: account.platform,
        status: account.status,
        currency: account.currency,
        dailyBudgetCents: account.dailyBudgetCents ?? null,
        paymentStatus: account.paymentStatus,
        consentForServerEvents: account.consentForServerEvents,
      })),
    };
  }
  return ctx;
}

export async function executeStepWithRuntime(input: StepExecutionInput): Promise<StepExecutionResult> {
  const { step, company, previousOutputs } = input;
  const startedAt = Date.now();

  if (getRuntimeEvalOverrides()?.orchestration?.forceBrokenExecution) {
    throw new Error("forced integration regression failure");
  }

  await assertSpendAvailable(company.id, 1, `Orchestration step ${step.id}`);
  await assertAgentTokenBudget(company.id, step.agentRole, TOKEN_ESTIMATE_PER_STEP);

  const runtime = await getAgentRuntime(company.id, step.agentRole);
  const stepText = `${step.title} ${step.expectedOutput}`;
  // Health-aware grounding: skip tools the metric monitor flagged as degraded
  // (published by the heartbeat sweep). Empty set on a miss → prior behavior.
  const degradedTools = getDegradedTools(company.id);
  const rankedTools = await routeToolsForStep(stepText, runtime.environment, 3, { degradedTools });
  const toolGuidance = rankedTools.length
    ? rankedTools.map((tool) => tool.name)
    : runtime.environment.tools;

  // Build the subtask for the seat agent loop (uses proper tier routing via model-gateway).
  const dependencyContext = step.dependsOn
    .map((dep) => `[${dep}]: ${previousOutputs[dep]?.slice(0, 1000) ?? "(missing)"}`)
    .join("\n");

  // Fetch live company context (tasks, approvals, usage, reports, memory) for this seat.
  const liveContext = await buildLiveContext(
    company.id,
    company,
    step.agentRole,
    [input.objective, step.title, step.expectedOutput].filter(Boolean).join("\n"),
  );
  const platformReadiness = liveContext.platformReadiness as { ready?: boolean; blockers?: unknown[] } | undefined;

  // The seat's task is its step — but it MUST serve the overall run objective.
  // Without this, seats only saw their generic step text and produced off-topic
  // work (e.g. "check spend vs budget" for a "analyze SpaceX stocks" objective).
  const seatObjective = input.objective
    ? `${step.title}: ${step.expectedOutput}\n\nThis is one step of the founder's overall goal: "${input.objective}". Do the part of THAT goal that belongs to the ${step.agentRole} seat. If this goal is outside your domain, say so in one line instead of inventing unrelated work.`
    : `${step.title}: ${step.expectedOutput}`;

  const subtask = {
    id: step.id,
    seat: step.agentRole,
    objective: seatObjective,
    dependsOn: step.dependsOn,
    spec: step.spec ?? buildStepSpec(step),
    outputContractId: `orchestration:${step.id}`,
    toolGuidance,
    boundaries: runtime.environment.approvalRequiredFor,
    input: { rationale: step.rationale, dependencyOutputs: dependencyContext },
    contextBundle: {
      company:         { name: company.name, brief: company.brief },
      overallObjective: input.objective ?? step.title,
      missionContract: runtime.slotContract.mission,
      deliverables:    runtime.slotContract.deliverables,
      riskLevel:       step.riskLevel,
      ...liveContext,
    },
    classification: {
      type:          step.agentRole,
      complexity:    (step.riskLevel === "high" ? "complex" : "standard") as "complex" | "standard",
      reversibility: (step.needsApproval ? "irreversible" : "reversible") as "irreversible" | "reversible",
    },
    budgetCents: runtime.environment.budgetCentsPerRun ?? 500,
  };

  // Skill reuse: prepend the company's live distilled skills for this step so the
  // seat follows proven procedures. Guarded + best-effort; a failure or an empty
  // store leaves the prompt unchanged. `skillApplied` feeds the OpenSpace applied
  // rate once Slice 2 derives traces from these steps.
  let systemPrompt = runtime.systemPrompt;
  let skillApplied = false;
  if (SKILL_INJECTION_ENABLED) {
    const { prelude, applied } = await buildCompanySkillPrelude(
      company.id,
      getLiveSkillStore(),
      stepText,
    ).catch(() => ({ prelude: "", applied: false }));
    if (prelude) {
      systemPrompt = `${prelude}\n\n${runtime.systemPrompt}`;
      skillApplied = applied;
    }
    const playbookBlock = await getCompanyPlaybookLog()
      .list(company.id)
      .then((entries) => renderPlaybookBlock(foldPlaybook(entries)))
      .catch(() => "");
    if (playbookBlock) {
      systemPrompt = `${playbookBlock}\n\n${systemPrompt}`;
    }
  }
  void skillApplied; // recorded on the trace once live trace derivation (Slice 2) lands

  // §3.2 — client-authored skills (Settings → Custom Skills): always-on prelude
  // through the same injection path. Best-effort; failures leave the prompt unchanged.
  const customSkills = await buildCustomSkillPrelude(company.id, stepText)
    .catch(() => ({ prelude: "", applied: false }));
  if (customSkills.prelude) {
    systemPrompt = `${customSkills.prelude}\n\n${systemPrompt}`;
  }

  // §3.3 — client-configured MCP servers as additional ToolAdapters.
  // Load only MCP servers relevant to this step so seats see a focused tool set.
  const mcpQuery = [
    step.title,
    step.expectedOutput,
    input.objective ?? "",
  ].filter(Boolean).join("\n");
  const mcpAdapters = await getMcpAdaptersForCompany(company.id, { query: mcpQuery, limit: 4 }).catch(() => []);
  const environment = mcpAdapters.length
    ? {
        ...runtime.environment,
        tools: [
          ...runtime.environment.tools,
          ...mcpAdapters.map((adapter) => adapter.name),
        ],
      }
    : runtime.environment;

  const agentResult = await runSeatAgent({
    companyId: company.id,
    runtime: mcpAdapters.length ? { ...runtime, environment } : runtime,
    adapters: mcpAdapters.length ? [...defaultAdapters, ...mcpAdapters] : undefined,
    subtask,
    systemPrompt,
    dynamicPrompt: dependencyContext
      ? `Previous step outputs:\n${dependencyContext}`
      : undefined,
    approvalGranted: input.approvalGranted,
    resumeSeed: input.resumeSeed,
    executeSeatModelFn: getRuntimeEvalOverrides()?.orchestration?.executeSeatModelFn,
    autonomy: { settings: getCompanyAutonomySettings(company) },
  });

  if (agentResult.pausedForApproval) {
    const pending = agentResult.pendingToolCall;
    const pendingRecord = findLastToolCall(agentResult.toolCalls, (record) => record.status === "needs_approval");
    if (!pending || !pendingRecord || agentResult.loopStep == null) {
      throw new Error("seat loop paused for approval without resumable state");
    }
    throw new SeatLoopAwaitingApprovalError({
      seatLoopState: {
        toolCalls: agentResult.toolCalls,
        loopStep: agentResult.loopStep,
        tokens: agentResult.tokens,
        costCents: agentResult.costCents,
        model: agentResult.model,
        pendingToolCall: pending,
      },
      toolCalls: agentResult.toolCalls,
      tokens: agentResult.tokens,
      costCents: agentResult.costCents,
      model: agentResult.model,
    });
  }

  const toolCalls: ToolCallRecord[] = [...agentResult.toolCalls];
  if (platformReadiness) {
    const blockers = Array.isArray(platformReadiness.blockers)
      ? platformReadiness.blockers.filter((item): item is string => typeof item === "string")
      : [];
    toolCalls.push({
      adapter: "platform_readiness",
      action: "check",
      status: platformReadiness.ready ? "completed" : "needs_approval",
      summary: platformReadiness.ready
        ? "Platform readiness passed for this content/social/ads mission."
        : `Platform readiness blocked external action: ${blockers.join("; ") || "missing platform readiness"}`,
    });
  }

  const seatResult = {
    output: agentResult.output,
    model: agentResult.model,
    tokens: agentResult.tokens,
    costCents: agentResult.costCents,
    error: agentResult.error,
  };
  const maxStepsReached = agentResult.maxStepsReached === true;

  // Extract text output — the model responds with JSON {summary, findings, recommendations, workRequests}.
  // findings/recommendations may come back as arrays of strings OR objects; coerce
  // each item to readable text so we never render "[object Object]".
  const rawOutput = seatResult.output as Record<string, unknown> | null;
  const summary     = typeof rawOutput?.summary === "string" ? rawOutput.summary : "";
  const findings    = toTextList(rawOutput?.findings);
  const recommendations = toTextList(rawOutput?.recommendations);
  const output = [summary, findings, recommendations].filter(Boolean).join("\n\n")
    || (seatResult.error ?? "(no output)");

  // §1 P1-3 — publish the validated handoff contract for dependent steps.
  const handoff = buildStepHandoff(step, rawOutput, output);

  // Extract work requests the agent wants routed to other agents.
  const rawWorkRequests = Array.isArray(rawOutput?.workRequests) ? rawOutput.workRequests : [];
  const workRequests: WorkRequest[] = rawWorkRequests
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    .map((r) => ({
      id:         makeId("wreq"),
      cycleId:    input.cycleId ?? step.id,
      companyId:  company.id,
      requester:  step.agentRole,
      capability: typeof r.capability === "string" ? r.capability : String(r.capability ?? ""),
      input:      r.input ?? null,
      budgetCents: typeof r.budgetCents === "number" ? r.budgetCents : 100,
      depth:       0,
    }))
    .filter((r) => r.capability.length > 0);

  const execRecord: AgentExecution = {
    id:         makeId("exec"),
    companyId:  company.id,
    cycleId:    input.cycleId,
    agentRole:  step.agentRole,
    input:      [
      `Step ${step.id}: ${step.title}`,
      `Mission: ${runtime.slotContract.mission}`,
      `Profile: ${runtime.profile?.name ?? runtime.v3Profile?.name ?? "Trent default"}`,
      `Model tier: ${seatResult.model}`,
    ].join("\n"),
    output,
    toolCalls,
    status:     seatResult.error || maxStepsReached ? "failed" : "completed",
    model:      seatResult.model,
    tokens:     seatResult.tokens,
    costCents:  seatResult.costCents,
    durationMs: Date.now() - startedAt,
    createdAt:  nowIso(),
  };

  return {
    output,
    handoff,
    model: seatResult.model,
    tokens: seatResult.tokens,
    costCents: seatResult.costCents,
    toolCalls,
    maxStepsReached,
    workRequests,
    execution: execRecord,
  };
}

export type OrchestrationTransition =
  | "run_start"
  | "step_start"
  | "step_approved"
  | "step_rejected"
  | "run_done"
  | "run_failed"
  | "run_cancelled";

export async function auditTransition(
  companyId: string,
  transition: OrchestrationTransition,
  runId: string,
  summary: string,
): Promise<void> {
  const actor = transition === "run_failed" ? "system" : "agent";
  await store.addAudit(
    companyId,
    actor,
    `orchestration.${transition}`,
    "orchestration",
    runId,
    summary,
  ).catch(() => {});
}
