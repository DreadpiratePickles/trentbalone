/**
 * lib/agent-ops.ts — Agent Operations Control Tower truth layer.
 *
 * Pure, deterministic projections that turn persisted durable-run state (runs,
 * steps, events, approvals, documents, integrations) into an operator-facing
 * payload: a run timeline, a grouped evidence ledger with provenance, a trust
 * summary, the approval queue, the memory-compounding view, and run-health
 * diagnostics.
 *
 * Honesty rules (the Trent wedge):
 *  - Never fabricate evidence. Data we cannot derive is reported as the honest
 *    value ("not recorded" / "not measured"), never invented.
 *  - Provenance is sourced from the same vocabulary as the runtime guards:
 *    real / connected / needs_credentials / mock / unavailable / internal.
 *  - Blocked prose claims (the anti-false-green guard's caveat) are surfaced,
 *    not hidden.
 *
 * Every builder takes already-loaded, company-scoped data (the route enforces
 * RLS + scoping); these functions do no I/O so they are trivially testable.
 */
import type {
  Approval,
  Cycle,
  Document,
  OrchestratorEvent,
  OrchestratorRun,
  OrchestratorStep,
  ToolCallRecord,
  ToolConnection,
} from "@/lib/types";
import { buildRunDiagnostics, truthfulRunStatus, type OpsDiagnostic } from "@/lib/agent-ops-diagnostics";

export type { OpsDiagnostic } from "@/lib/agent-ops-diagnostics";

// ── Provenance / status vocab ───────────────────────────────────────────────

export type OpsEvidenceSource =
  | "real"
  | "connected"
  | "needs_credentials"
  | "mock"
  | "unavailable"
  | "internal"
  | "approval_required";

export type OpsEvidenceStatus =
  | "completed"
  | "failed"
  | "degraded"
  | "approval_required"
  | "blocked"
  | "mocked";

export type OpsEvidenceGroup =
  | "tool_call"
  | "workbench"
  | "browser"
  | "provider_read"
  | "email"
  | "github"
  | "mcp"
  | "report"
  | "approval";

export type OpsClaimState = "verified" | "unverified_blocked" | "not_applicable";

export type OpsEvidenceRow = {
  id: string;
  group: OpsEvidenceGroup;
  status: OpsEvidenceStatus;
  source: OpsEvidenceSource;
  timestamp?: string;
  seat?: string;
  summary: string;
  artifactId?: string;
  claim: OpsClaimState;
};

// ── Run timeline ────────────────────────────────────────────────────────────

export type OpsRunSummary = {
  id: string;
  objective: string;
  trigger: OrchestratorRun["trigger"];
  triggerLabel: string;
  status: OrchestratorRun["status"];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  seats: string[];
  approvalsRequested: number;
  toolsUsed: number;
  evidenceCount: number;
  failureCount: number;
  degradedCount: number;
  memoryWrites: number;
  ceoSummary?: string;
  cycleId?: string;
};

// ── Trust summary ───────────────────────────────────────────────────────────

export type OpsTrustSummary = {
  realToolCalls: number;
  mockOrTestCalls: number;
  unavailableOrNeedsCredentials: number;
  blockedProseClaims: number;
  approvalRequiredActions: number;
  degradedButUsableOutputs: number;
  noUnverifiedClaims: boolean;
  blockedClaimEvidence: string[];
};

// ── Approvals ───────────────────────────────────────────────────────────────

export type OpsApproval = {
  id: string;
  seat?: string;
  action: string;
  reason: string;
  riskLevel: "low" | "medium" | "high";
  tool?: string;
  source: OpsEvidenceSource;
  createdAt: string;
  status: Approval["status"];
};

// ── Memory compounding ──────────────────────────────────────────────────────

export type OpsMemoryEntry = { id: string; title: string; kind: string; tier?: string; validFrom?: string };

export type OpsMemoryCompounding = {
  decisionJournal: OpsMemoryEntry[];
  registryEntries: OpsMemoryEntry[];
  memoryWrites: OpsMemoryEntry[];
  writesByTier: Record<string, number>;
  priorMemory: {
    status: "available" | "none" | "not_recorded";
    label: string;
    ids: string[];
  };
};

// ── Run detail + payload ────────────────────────────────────────────────────

export type OpsRunDetail = {
  summary: OpsRunSummary;
  truthfulStatus: OrchestratorRun["status"];
  statusReconciled: boolean;
  evidenceLedger: OpsEvidenceRow[];
  evidenceByGroup: Array<{ group: OpsEvidenceGroup; rows: OpsEvidenceRow[] }>;
  trustSummary: OpsTrustSummary;
  approvals: OpsApproval[];
  memoryCompounding: OpsMemoryCompounding;
  diagnostics: OpsDiagnostic[];
};

export type AgentOpsPayload = {
  companyId: string;
  generatedAt: string;
  recentRuns: OpsRunSummary[];
  selectedRun?: OpsRunDetail;
};

export type OpsRunBundle = {
  run: OrchestratorRun;
  steps: OrchestratorStep[];
  events: OrchestratorEvent[];
  approvals: Approval[];
  documents: Document[];
  integrations: ToolConnection[];
  cycle?: Cycle;
  now: string;
};

const DEGRADED_MARKER = /DEGRADED/;
const UNVERIFIED_MARKER = /UNVERIFIED TOOL CLAIM/;

const GROUP_ORDER: OpsEvidenceGroup[] = [
  "workbench", "browser", "provider_read", "email", "github", "mcp", "tool_call", "report", "approval",
];

// ── Classification helpers ──────────────────────────────────────────────────

export function classifyEvidenceGroup(adapter: string): OpsEvidenceGroup {
  const a = adapter.toLowerCase();
  if (/workbench|sandbox|\be2b\b|daytona/.test(a)) return "workbench";
  if (/browser|playwright|screenshot|steel|\bweb\b|crawl/.test(a)) return "browser";
  if (/stripe|posthog|sentry|ga4|analytics|attio|hubspot|\bcrm\b/.test(a)) return "provider_read";
  if (/email|resend|postmark|gmail|inbox|newsletter/.test(a)) return "email";
  if (/github|\bgit\b/.test(a)) return "github";
  if (/\bmcp\b/.test(a)) return "mcp";
  return "tool_call";
}

/** Map a persisted tool call's status to an honest (status, source) pair. */
export function classifyToolCall(call: ToolCallRecord): { status: OpsEvidenceStatus; source: OpsEvidenceSource } {
  const summary = call.summary?.toLowerCase() ?? "";
  switch (call.status) {
    case "mocked":
      return { status: "mocked", source: "mock" };
    case "needs_approval":
      return { status: "approval_required", source: "approval_required" };
    case "completed":
      return { status: "completed", source: "real" };
    case "blocked":
      return { status: "blocked", source: "unavailable" };
    case "failed":
    default:
      if (/not configured|needs? cred|missing.*key|no api key/.test(summary)) {
        return { status: "failed", source: "needs_credentials" };
      }
      if (/not permitted|not allowed|unavailable|seat restriction/.test(summary)) {
        return { status: "failed", source: "unavailable" };
      }
      return { status: "failed", source: "connected" };
  }
}

// ── Filtering company data down to one run ──────────────────────────────────

export function approvalsForRun(approvals: Approval[], run: OrchestratorRun, steps: OrchestratorStep[]): Approval[] {
  const stepApprovalIds = new Set(steps.map((s) => s.approvalId).filter((id): id is string => Boolean(id)));
  return approvals.filter(
    (a) => stepApprovalIds.has(a.id) || (a.toolName?.includes(`orchestration:${run.id}`) ?? false),
  );
}

export function documentsForRun(documents: Document[], run: OrchestratorRun): Document[] {
  return documents.filter((doc) => doc.source?.includes(run.id));
}

// ── Run timeline ────────────────────────────────────────────────────────────

function deriveTriggerLabel(run: OrchestratorRun): string {
  if (/\b(proof|eval|smoke|bakeoff)\b/i.test(run.objective)) return "proof";
  if (run.trigger === "heartbeat") return "nightly";
  return run.trigger;
}

export function buildRunSummary(bundle: Pick<OpsRunBundle, "run" | "steps" | "approvals" | "documents">): OpsRunSummary {
  const { run, steps } = bundle;
  const runApprovals = approvalsForRun(bundle.approvals, run, steps);
  const runDocs = documentsForRun(bundle.documents, run);
  const toolCalls = steps.flatMap((s) => s.toolCalls ?? []);
  const seats = [...new Set(steps.map((s) => s.agentRole))];
  const failureCount = steps.filter((s) => s.status === "failed" || s.status === "blocked").length;
  const degradedCount = steps.filter((s) => (s.output ? DEGRADED_MARKER.test(s.output) : false)).length;
  const startedAt = run.startedAt;
  const durationMs = run.completedAt
    ? Math.max(0, new Date(run.completedAt).getTime() - new Date(startedAt).getTime())
    : undefined;

  return {
    id: run.id,
    objective: run.objective,
    trigger: run.trigger,
    triggerLabel: deriveTriggerLabel(run),
    status: run.status,
    startedAt,
    completedAt: run.completedAt,
    durationMs,
    seats,
    approvalsRequested: runApprovals.length,
    toolsUsed: toolCalls.length,
    evidenceCount: toolCalls.length + runDocs.length + runApprovals.length,
    failureCount,
    degradedCount,
    memoryWrites: runDocs.length,
    ceoSummary: run.summary,
    cycleId: run.cycleId,
  };
}

// ── Evidence ledger ─────────────────────────────────────────────────────────

export function buildEvidenceLedger(bundle: OpsRunBundle): OpsEvidenceRow[] {
  const rows: OpsEvidenceRow[] = [];
  const runApprovals = approvalsForRun(bundle.approvals, bundle.run, bundle.steps);
  const runDocs = documentsForRun(bundle.documents, bundle.run);

  for (const step of bundle.steps) {
    const stepUnverified = step.output ? UNVERIFIED_MARKER.test(step.output) : false;
    for (const [index, call] of (step.toolCalls ?? []).entries()) {
      const { status, source } = classifyToolCall(call);
      rows.push({
        id: `${step.id}:tool:${index}`,
        group: classifyEvidenceGroup(call.adapter),
        status,
        source,
        timestamp: step.completedAt ?? step.startedAt,
        seat: step.agentRole,
        summary: `${call.adapter} · ${truncate(call.summary || call.action, 200)}`,
        claim: status === "completed"
          ? (stepUnverified ? "unverified_blocked" : "verified")
          : "not_applicable",
      });
    }
  }

  for (const doc of runDocs) {
    rows.push({
      id: `doc:${doc.id}`,
      group: "report",
      status: "completed",
      source: "internal",
      timestamp: doc.validFrom ?? doc.createdAt,
      summary: truncate(doc.title, 200),
      artifactId: doc.id,
      claim: "not_applicable",
    });
  }

  for (const approval of runApprovals) {
    rows.push({
      id: `approval:${approval.id}`,
      group: "approval",
      status: "approval_required",
      source: "approval_required",
      timestamp: approval.createdAt,
      seat: seatFromToolName(approval.toolName),
      summary: truncate(approval.action, 200),
      artifactId: approval.id,
      claim: "not_applicable",
    });
  }

  return rows;
}

export function groupEvidence(rows: OpsEvidenceRow[]): Array<{ group: OpsEvidenceGroup; rows: OpsEvidenceRow[] }> {
  return GROUP_ORDER.map((group) => ({ group, rows: rows.filter((row) => row.group === group) }))
    .filter((bucket) => bucket.rows.length > 0);
}

// ── Trust summary ───────────────────────────────────────────────────────────

export function buildTrustSummary(bundle: OpsRunBundle, ledger: OpsEvidenceRow[]): OpsTrustSummary {
  const toolish = ledger.filter((row) => row.group !== "report" && row.group !== "approval");
  const blockedClaimEvidence: string[] = [];
  for (const step of bundle.steps) {
    if (step.output && UNVERIFIED_MARKER.test(step.output)) {
      blockedClaimEvidence.push(`${step.agentRole} · ${truncate(firstMatchingSentence(step.output, UNVERIFIED_MARKER), 200)}`);
    }
  }
  const runApprovals = approvalsForRun(bundle.approvals, bundle.run, bundle.steps);
  const approvalRequiredActions =
    runApprovals.filter((a) => a.status === "pending").length +
    toolish.filter((row) => row.status === "approval_required").length;
  const degradedButUsableOutputs = bundle.steps.filter(
    (s) => s.status === "completed" && s.output != null && DEGRADED_MARKER.test(s.output),
  ).length;

  return {
    realToolCalls: toolish.filter((row) => row.source === "real").length,
    mockOrTestCalls: toolish.filter((row) => row.source === "mock").length,
    unavailableOrNeedsCredentials: toolish.filter(
      (row) => row.source === "needs_credentials" || row.source === "unavailable",
    ).length,
    blockedProseClaims: blockedClaimEvidence.length,
    approvalRequiredActions,
    degradedButUsableOutputs,
    noUnverifiedClaims: blockedClaimEvidence.length === 0,
    blockedClaimEvidence,
  };
}

// ── Approvals ───────────────────────────────────────────────────────────────

export function buildApprovals(bundle: OpsRunBundle): OpsApproval[] {
  const runApprovals = approvalsForRun(bundle.approvals, bundle.run, bundle.steps);
  const stepByApprovalId = new Map(
    bundle.steps.filter((s) => s.approvalId).map((s) => [s.approvalId as string, s]),
  );
  return runApprovals
    .map((approval) => {
      const step = stepByApprovalId.get(approval.id);
      const riskLevel = normalizeRisk(step?.riskLevel) ?? "medium";
      return {
        id: approval.id,
        seat: step?.agentRole ?? seatFromToolName(approval.toolName),
        action: approval.action,
        reason: approval.reason,
        riskLevel,
        tool: approval.toolName,
        source: "approval_required" as OpsEvidenceSource,
        createdAt: approval.createdAt,
        status: approval.status,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Memory compounding ──────────────────────────────────────────────────────

export function buildMemoryCompounding(bundle: OpsRunBundle): OpsMemoryCompounding {
  const runDocs = documentsForRun(bundle.documents, bundle.run);
  const decisionJournal = runDocs
    .filter((d) => d.source?.startsWith("ceo-decision-journal:"))
    .map((d) => toMemoryEntry(d, "decision_journal"));
  const registryEntries = runDocs
    .filter((d) => d.source?.startsWith("seat-registry:"))
    .map((d) => toMemoryEntry(d, registryKindFromSource(d.source)));
  const memoryWrites = runDocs.map((d) => toMemoryEntry(d, d.type));

  const writesByTier: Record<string, number> = {};
  for (const doc of runDocs) {
    const tier = doc.memoryTier ?? "untiered";
    writesByTier[tier] = (writesByTier[tier] ?? 0) + 1;
  }

  // "Prior memory available to recall" — registry/journal/episodic docs that
  // existed BEFORE this run started were recallable by it. We do not claim the
  // run *used* them (not provable from persisted state); we report availability.
  const priorDocs = bundle.documents.filter((doc) => {
    if (!isCompoundingDoc(doc)) return false;
    if (documentsForRun([doc], bundle.run).length > 0) return false; // exclude this run's own writes
    const when = doc.validFrom ?? doc.createdAt;
    return Boolean(when) && when < bundle.run.startedAt;
  });
  const priorMemory = priorDocs.length
    ? { status: "available" as const, label: "Prior memory available to recall", ids: priorDocs.slice(0, 12).map((d) => d.id) }
    : { status: "none" as const, label: "No prior compounding memory found", ids: [] };

  return { decisionJournal, registryEntries, memoryWrites, writesByTier, priorMemory };
}

// ── Assembly ────────────────────────────────────────────────────────────────

export function buildRunDetail(bundle: OpsRunBundle): OpsRunDetail {
  const ledger = buildEvidenceLedger(bundle);
  const truthful = truthfulRunStatus(bundle.run.status, bundle.steps, bundle.events);
  return {
    summary: buildRunSummary(bundle),
    truthfulStatus: truthful.status,
    statusReconciled: truthful.reconciled,
    evidenceLedger: ledger,
    evidenceByGroup: groupEvidence(ledger),
    trustSummary: buildTrustSummary(bundle, ledger),
    approvals: buildApprovals(bundle),
    memoryCompounding: buildMemoryCompounding(bundle),
    diagnostics: buildRunDiagnostics(bundle),
  };
}

export function buildRecentRunSummaries(
  runs: OrchestratorRun[],
  perRun: Map<string, { steps: OrchestratorStep[] }>,
  approvals: Approval[],
  documents: Document[],
  limit = 25,
): OpsRunSummary[] {
  return [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
    .map((run) =>
      buildRunSummary({
        run,
        steps: perRun.get(run.id)?.steps ?? [],
        approvals,
        documents,
      }),
    );
}

// ── small helpers ───────────────────────────────────────────────────────────

function truncate(value: string, max: number): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function firstMatchingSentence(text: string, marker: RegExp): string {
  for (const sentence of text.split(/(?<=[.!?\n])\s+|\n+/)) {
    if (marker.test(sentence)) return sentence.trim();
  }
  return text.trim();
}

function seatFromToolName(toolName?: string): string | undefined {
  if (!toolName) return undefined;
  const match = toolName.match(/^(ceo|engineer|growth|content|support|analyst|finance|escalation|sales)\b/i);
  return match ? match[1].toLowerCase() : undefined;
}

function normalizeRisk(value?: string): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function toMemoryEntry(doc: Document, kind: string): OpsMemoryEntry {
  return { id: doc.id, title: doc.title, kind, tier: doc.memoryTier, validFrom: doc.validFrom };
}

function registryKindFromSource(source: string): string {
  const match = source.match(/^seat-registry:([a-z]+):/i);
  return match ? `${match[1]}_registry` : "registry";
}

function isCompoundingDoc(doc: Document): boolean {
  if (doc.source?.startsWith("ceo-decision-journal:") || doc.source?.startsWith("seat-registry:")) return true;
  return doc.memoryTier === "semantic" || doc.memoryTier === "episodic";
}
