/**
 * lib/agent-ops-diagnostics.ts — run-health diagnostics for the Ops Control Tower.
 *
 * Each diagnostic catches a failure class Trent has actually seen. The cardinal
 * rule: never overclaim. A diagnostic that cannot be computed from persisted
 * state returns `not_measured`, not a green "ok".
 */
import type {
  OrchestratorEvent,
  OrchestratorRun,
  OrchestratorStep,
  ToolConnection,
} from "@/lib/types";

export type OpsDiagnosticStatus = "ok" | "warn" | "fail" | "info" | "not_measured";

export type OpsDiagnostic = {
  id: string;
  label: string;
  status: OpsDiagnosticStatus;
  detail: string;
};

type DiagnosticsBundle = {
  run: OrchestratorRun;
  steps: OrchestratorStep[];
  events: OrchestratorEvent[];
  integrations: ToolConnection[];
  now: string;
};

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const SETTLED_STEP_STATUSES = new Set(["completed", "failed", "blocked", "awaiting_approval"]);
const TERMINAL_EVENT_STATUS: Record<string, OrchestratorRun["status"]> = {
  run_done: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
};

const STUCK_MS = 15 * 60 * 1000;
const HEARTBEAT_GAP_MS = 5 * 60 * 1000;

/**
 * Lightweight, self-contained truthful-status derivation (mirrors the dedicated
 * reconciliation work but kept local so this branch is independent): a terminal
 * run event wins, else an all-settled step set, else the persisted status.
 */
export function truthfulRunStatus(
  persisted: OrchestratorRun["status"],
  steps: Array<{ status: string }>,
  events: Array<{ kind: string; seq?: number }>,
): { status: OrchestratorRun["status"]; reconciled: boolean } {
  if (TERMINAL_RUN_STATUSES.has(persisted) || persisted === "awaiting_approval") {
    return { status: persisted, reconciled: false };
  }
  const terminalEvent = [...events]
    .filter((e) => TERMINAL_EVENT_STATUS[e.kind])
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .at(-1);
  if (terminalEvent) {
    const status = TERMINAL_EVENT_STATUS[terminalEvent.kind];
    return { status, reconciled: status !== persisted };
  }
  if (steps.length && steps.every((s) => SETTLED_STEP_STATUSES.has(s.status))) {
    // Reached only when persisted is non-terminal (planning/running), so any
    // status we derive here is, by definition, a reconciliation.
    if (steps.some((s) => s.status === "awaiting_approval")) {
      return { status: "awaiting_approval", reconciled: true };
    }
    const fatal = steps.some((s) => s.status === "failed" || s.status === "blocked");
    return { status: fatal ? "failed" : "completed", reconciled: true };
  }
  return { status: persisted, reconciled: false };
}

export function buildRunDiagnostics(bundle: DiagnosticsBundle): OpsDiagnostic[] {
  return [
    staleSnapshotDiagnostic(bundle),
    criticRepairDiagnostic(bundle),
    workerHeartbeatDiagnostic(bundle),
    providerConfiguredDiagnostic(bundle),
    sandboxProofDiagnostic(bundle),
    browserProofDiagnostic(bundle),
    runStuckDiagnostic(bundle),
    awaitingApprovalDiagnostic(bundle),
  ];
}

function staleSnapshotDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "stale-snapshot-trace";
  const label = "Snapshot vs trace agreement";
  if (!b.steps.length && !b.events.length) {
    return { id, label, status: "not_measured", detail: "No steps or trace events recorded yet." };
  }
  const truthful = truthfulRunStatus(b.run.status, b.steps, b.events);
  if (truthful.reconciled) {
    return {
      id,
      label,
      status: "warn",
      detail: `Persisted status "${b.run.status}" disagrees with trace/steps ("${truthful.status}"). Snapshot is stale.`,
    };
  }
  return { id, label, status: "ok", detail: `Snapshot agrees with the trace ("${b.run.status}").` };
}

function criticRepairDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "critic-schema-repair";
  const label = "Critic schema health";
  const critiques = b.steps.map((s) => s.critique).filter(Boolean) as Array<Record<string, unknown>>;
  if (!critiques.length) {
    return { id, label, status: "not_measured", detail: "No critic verdicts recorded for this run." };
  }
  const failures = critiques.filter((c) => {
    const reason = typeof c.reason === "string" ? c.reason : "";
    return /critic LLM call failed|schema validation|failed schema/i.test(reason);
  }).length;
  if (failures > 0) {
    return {
      id,
      label,
      status: "warn",
      detail: `${failures} critic schema/infra failure(s) detected. Repair telemetry is not persisted on this build (not measured).`,
    };
  }
  return { id, label, status: "ok", detail: `${critiques.length} critic verdict(s), no schema failures detected.` };
}

function workerHeartbeatDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "worker-heartbeat";
  const label = "Worker heartbeat";
  if (TERMINAL_RUN_STATUSES.has(b.run.status)) {
    return { id, label, status: "ok", detail: "Run is terminal; no live worker expected." };
  }
  if (!b.events.length) {
    return { id, label, status: "not_measured", detail: "No trace events to measure activity from." };
  }
  const lastEventAt = [...b.events]
    .map((e) => e.createdAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!lastEventAt) {
    return { id, label, status: "not_measured", detail: "Trace events have no timestamps." };
  }
  const gap = new Date(b.now).getTime() - new Date(lastEventAt).getTime();
  if (gap > HEARTBEAT_GAP_MS) {
    return { id, label, status: "warn", detail: `No run activity for ${Math.round(gap / 60000)}m while status is "${b.run.status}".` };
  }
  return { id, label, status: "ok", detail: `Last activity ${Math.round(gap / 1000)}s ago.` };
}

function providerConfiguredDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "provider-configured";
  const label = "Provider readiness";
  const toolCalls = b.steps.flatMap((s) => s.toolCalls ?? []);
  const needsCreds = toolCalls.filter((c) =>
    c.status === "failed" && /not configured|needs? cred|missing.*key|no api key/i.test(c.summary ?? ""),
  );
  const missingIntegrations = b.integrations.filter((i) => i.status === "needs_credentials");
  if (!toolCalls.length && !missingIntegrations.length) {
    return { id, label, status: "not_measured", detail: "No provider tool calls in this run." };
  }
  if (needsCreds.length || missingIntegrations.length) {
    const providers = [
      ...new Set([
        ...needsCreds.map((c) => c.adapter),
        ...missingIntegrations.map((i) => i.provider),
      ]),
    ];
    return { id, label, status: "warn", detail: `Needs credentials: ${providers.slice(0, 6).join(", ")}.` };
  }
  return { id, label, status: "ok", detail: "All referenced providers are connected." };
}

function sandboxProofDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "sandbox-proof";
  const label = "Sandbox build evidence";
  const engineerSteps = b.steps.filter((s) => s.agentRole === "engineer");
  const sandboxCalls = b.steps.flatMap((s) => s.toolCalls ?? []).filter((c) =>
    /workbench|sandbox|\be2b\b|daytona/i.test(c.adapter),
  );
  if (!engineerSteps.length) {
    return { id, label, status: "not_measured", detail: "No engineer steps in this run." };
  }
  if (!sandboxCalls.length) {
    return { id, label, status: "warn", detail: "Engineer step ran with no sandbox/workbench evidence recorded." };
  }
  return { id, label, status: "ok", detail: `${sandboxCalls.length} sandbox/workbench tool call(s) recorded.` };
}

function browserProofDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "browser-proof";
  const label = "Browser verification";
  const browserCalls = b.steps.flatMap((s) => s.toolCalls ?? []).filter((c) =>
    /browser|playwright|screenshot|steel/i.test(c.adapter),
  );
  if (!browserCalls.length) {
    return { id, label, status: "not_measured", detail: "No browser-verification tool calls recorded." };
  }
  return { id, label, status: "ok", detail: `${browserCalls.length} browser tool call(s) recorded.` };
}

function runStuckDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "run-stuck";
  const label = "Run progress";
  if (b.run.status !== "planning" && b.run.status !== "running") {
    return { id, label, status: "ok", detail: `Run is "${b.run.status}".` };
  }
  const age = new Date(b.now).getTime() - new Date(b.run.startedAt).getTime();
  if (age > STUCK_MS) {
    return { id, label, status: "warn", detail: `Run has been "${b.run.status}" for ${Math.round(age / 60000)}m.` };
  }
  return { id, label, status: "ok", detail: `Running for ${Math.round(age / 60000)}m.` };
}

function awaitingApprovalDiagnostic(b: DiagnosticsBundle): OpsDiagnostic {
  const id = "awaiting-approval";
  const label = "Approval gate";
  const awaiting = b.steps.filter((s) => s.status === "awaiting_approval").length;
  if (b.run.status === "awaiting_approval" || awaiting > 0) {
    return { id, label, status: "info", detail: `${awaiting || 1} step(s) paused for founder approval.` };
  }
  return { id, label, status: "ok", detail: "No steps blocked on approval." };
}
