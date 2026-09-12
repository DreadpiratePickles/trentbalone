import type { JobRun } from "@/lib/types";

export type RunCycleControlStatus =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "lost_contact"
  | "cancelled";

export type RunCycleControlState = {
  status: RunCycleControlStatus;
  jobId: string | null;
  runId: string | null;
  cycleId: string | null;
  label: string | null;
  error: string | null;
  approvalId: string | null;
  lastEventAt: string | null;
};

export type RunCycleEvent = {
  status?: string;
  jobRunId?: string;
  summary?: string;
  at?: string;
  jobRun?: JobRun;
  step?: {
    phase?: string;
    role?: string;
    label?: string;
  };
};

export type RunCycleOrchestratorSnapshot = {
  id: string;
  cycleId?: string;
  status: string;
  updatedAt?: string;
  completedAt?: string;
  summary?: string;
};

type OrchestrationRunMetadata = {
  id?: unknown;
  cycleId?: unknown;
  status?: unknown;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function emptyRunCycleControl(): RunCycleControlState {
  return {
    status: "idle",
    jobId: null,
    runId: null,
    cycleId: null,
    label: null,
    error: null,
    approvalId: null,
    lastEventAt: null,
  };
}

export function runCycleIsActive(state: RunCycleControlState) {
  return state.status !== "idle" && !TERMINAL_STATUSES.has(state.status);
}

export function buildRunCycleControl(input: { job?: JobRun | null; now?: string }): RunCycleControlState {
  const state = emptyRunCycleControl();
  const job = input.job;
  if (!job || job.type !== "company_scheduled_cycle") return state;

  const run = readRunMetadata(job);
  const runStatus = typeof run?.status === "string" ? run.status : null;
  const status = statusFromJob(job, runStatus);
  return {
    ...state,
    status,
    jobId: job.id,
    runId: typeof run?.id === "string" ? run.id : null,
    cycleId: typeof run?.cycleId === "string" ? run.cycleId : null,
    label: labelForStatus(status),
    error: job.error ?? null,
    lastEventAt: job.completedAt ?? job.startedAt ?? input.now ?? null,
  };
}

export function summarizeJobRunForCycleControl(jobRuns: JobRun[]): RunCycleControlState | null {
  const cycleJobs = jobRuns
    .filter((job) => job.type === "company_scheduled_cycle")
    .sort((a, b) => dateValue(b.startedAt) - dateValue(a.startedAt));

  const active = cycleJobs.find((job) => job.status === "running");
  const latest = active ?? cycleJobs[0];
  return latest ? buildRunCycleControl({ job: latest }) : null;
}

export function mergeOrchestratorRunIntoCycleControl(
  current: RunCycleControlState,
  run: RunCycleOrchestratorSnapshot | null | undefined
): RunCycleControlState {
  if (!run) return current;
  if (current.runId && current.runId !== run.id) return current;
  const status = statusFromRun(run.status);
  return {
    ...current,
    status,
    runId: run.id,
    cycleId: run.cycleId ?? current.cycleId,
    label: labelForStatus(status),
    error: run.status === "failed" ? (run.summary ?? current.error) : current.error,
    lastEventAt: run.completedAt ?? run.updatedAt ?? current.lastEventAt,
  };
}

export function runCycleEventReducer(
  current: RunCycleControlState,
  event: RunCycleEvent
): RunCycleControlState {
  if (event.status === "connected") return current;

  if (event.status === "lost_contact") {
    if (!runCycleIsActive(current)) return current;
    return {
      ...current,
      status: "lost_contact",
      label: "reconnecting",
      error: event.summary ?? current.error,
      lastEventAt: event.at ?? current.lastEventAt,
    };
  }

  const job = event.jobRun;
  const reconciled = job ? buildRunCycleControl({ job }) : null;
  const base: RunCycleControlState = reconciled ?? {
    ...current,
    jobId: event.jobRunId ?? current.jobId,
    lastEventAt: event.at ?? current.lastEventAt,
  };

  if (event.status === "queued") {
    return { ...base, status: "queued", label: "queued" };
  }

  if (event.status === "started") {
    return { ...base, status: "starting", label: "starting" };
  }

  if (event.status === "running") {
    return { ...base, status: "running", label: "running" };
  }

  if (event.status === "step") {
    const approvalId = event.step?.phase === "approval_required"
      ? extractApprovalId(event.step.label)
      : base.approvalId;
    const status = event.step?.phase === "approval_required" ? "awaiting_approval" : "running";
    return {
      ...base,
      status,
      approvalId,
      label: labelForStep(event.step) ?? labelForStatus(status),
    };
  }

  if (event.status === "completed") {
    return { ...base, status: "completed", label: "completed" };
  }

  if (event.status === "failed") {
    return {
      ...base,
      status: "failed",
      label: "failed",
      error: event.summary ?? base.error,
    };
  }

  if (event.status === "cancelled") {
    return { ...base, status: "cancelled", label: "cancelled" };
  }

  return base;
}

function statusFromRun(status: string): RunCycleControlStatus {
  if (status === "awaiting_approval") return "awaiting_approval";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "planning") return "starting";
  return "running";
}

function statusFromJob(job: JobRun, runStatus: string | null): RunCycleControlStatus {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "failed") return "failed";
  if (runStatus === "awaiting_approval") return "awaiting_approval";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  if (runStatus === "completed") return "completed";
  if (runStatus === "running" || runStatus === "planning") return "running";
  if (job.status === "completed") return runStatus ? "running" : "completed";
  return "queued";
}

function readRunMetadata(job: JobRun): OrchestrationRunMetadata | null {
  const result = job.metadata?.result;
  if (!isRecord(result)) return null;
  const run = result.run;
  return isRecord(run) ? run : null;
}

function labelForStep(step: RunCycleEvent["step"]) {
  if (!step) return null;
  if (step.phase === "approval_required") return "approval needed";
  if (step.phase === "agent_start" && step.role) return `${step.role} agent`;
  if (step.phase === "plan_start") return "planning";
  if (step.phase === "plan_end") return "plan ready";
  return step.label || null;
}

function labelForStatus(status: RunCycleControlStatus) {
  if (status === "awaiting_approval") return "approval needed";
  if (status === "lost_contact") return "reconnecting";
  if (status === "idle") return null;
  return status.replace("_", " ");
}

function extractApprovalId(label?: string) {
  if (!label) return null;
  return label.match(/\bapproval_[a-z0-9]+\b/i)?.[0] ?? null;
}

function dateValue(value?: string) {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
