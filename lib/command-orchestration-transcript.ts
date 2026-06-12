export type CommandRun = {
  id: string;
  objective: string;
  status: string;
  startedAt: string;
  summary?: string;
  completedAt?: string;
};

type CommandRunSnapshot = Partial<CommandRun> & {
  id: string;
  steps?: unknown[];
};

export type CommandStepPayload = {
  id?: string;
  title?: string;
  agentRole?: string;
  status?: string;
  output?: string;
  model?: string;
  costCents?: number;
  approvalId?: string;
  critique?: { verdict?: string; reason?: string; improvement?: string };
};

export type OrchStreamPayload = {
  kind?: string;
  step?: CommandStepPayload;
  run?: CommandRunSnapshot;
  detail?: string;
  id?: string;
  objective?: string;
  status?: string;
  startedAt?: string;
  summary?: string;
  completedAt?: string;
  steps?: unknown[];
};

export type OrchestrationTranscriptState = {
  runId: string;
  lines: string[];
  seenOutputs: Set<string>;
  seenStarts: Set<string>;
  seenCritiques: Set<string>;
  seenNotices: Set<string>;
  planAnnounced: boolean;
};

export type OrchestrationTranscriptResult = {
  content: string;
  done: boolean;
  runStatus?: string;
  summary?: string;
  detail?: string;
};

export function createOrchestrationTranscript(runId: string): OrchestrationTranscriptState {
  return {
    runId,
    lines: [`◈ Orchestrator run ${runId} is running.`, ""],
    seenOutputs: new Set(),
    seenStarts: new Set(),
    seenCritiques: new Set(),
    seenNotices: new Set(),
    planAnnounced: false,
  };
}

export const ORCHESTRATION_TRANSCRIPT_EVENTS = [
  "snapshot",
  "plan_end",
  "step_pending",
  "step_start",
  "step_output",
  "step_critic",
  "step_note",
  "step_blocked",
  "step_awaiting_approval",
  "step_approved",
  "consolidate_end",
  "run_awaiting_approval",
  "run_done",
  "run_failed",
  "run_cancelled",
] as const;

export function applyOrchestrationTranscriptEvent(
  state: OrchestrationTranscriptState,
  eventName: string,
  payload: OrchStreamPayload,
): OrchestrationTranscriptResult {
  if (eventName === "snapshot") return applySnapshot(state, payload);
  if (eventName === "plan_end") {
    const count = Array.isArray(payload.run?.steps) ? payload.run.steps.length : 0;
    appendPlan(state, count);
  } else if (eventName === "step_start") {
    appendStart(state, payload.step);
  } else if (eventName === "step_output") {
    appendOutput(state, payload.step);
  } else if (eventName === "step_critic") {
    appendCritic(state, payload.step);
  } else if (eventName === "step_blocked") {
    appendNotice(state, "Blocked", payload.step, payload.detail ?? "Step blocked.");
  } else if (eventName === "step_awaiting_approval") {
    appendNotice(state, "Awaiting approval", payload.step, approvalDetail(payload.step, payload.detail));
  } else if (eventName === "step_approved") {
    appendNotice(state, "Approved", payload.step, approvalDetail(payload.step, payload.detail));
  } else if (eventName === "step_note" || eventName === "step_pending") {
    appendNotice(state, eventName === "step_pending" ? "Delegated" : "Note", payload.step, payload.detail ?? "No detail recorded.");
  } else if (eventName === "consolidate_end") {
    if (payload.run?.summary) state.lines.push("", `CEO consolidation:\n${payload.run.summary}`);
  } else if (eventName === "run_done") {
    const summary = payload.run?.summary;
    if (summary) state.lines.push("", `CEO final review:\n${summary}`);
    else state.lines.push("", "Run completed.");
    return result(state, true, "completed", summary);
  } else if (eventName === "run_awaiting_approval") {
    const detail = payload.detail ?? payload.run?.summary ?? "Approval required before this run can continue.";
    state.lines.push("", `Run awaiting approval: ${detail}`);
    return result(state, true, "awaiting_approval", payload.run?.summary, detail);
  } else if (eventName === "run_failed") {
    const detail = payload.detail ?? "unknown error";
    state.lines.push("", `Run failed: ${detail}`);
    return result(state, true, "failed", payload.run?.summary, detail);
  } else if (eventName === "run_cancelled") {
    state.lines.push("", "Run cancelled.");
    return result(state, true, "cancelled");
  }
  return result(state, false);
}

function applySnapshot(
  state: OrchestrationTranscriptState,
  payload: OrchStreamPayload,
): OrchestrationTranscriptResult {
  const run = payload.run ?? (typeof payload.id === "string" ? payload as CommandRunSnapshot : undefined);
  const steps = Array.isArray(run?.steps)
    ? run.steps.map(asStep).filter((step): step is CommandStepPayload => step !== null)
    : [];
  appendPlan(state, steps.length);
  for (const step of steps) {
    if (step.status === "running") appendStart(state, step);
    if (step.output?.trim()) appendOutput(state, step);
    if (step.critique) appendCritic(state, step);
    if (step.status === "blocked") appendNotice(state, "Blocked", step, approvalDetail(step, "Step blocked."));
  }
  if (run?.status === "completed") {
    const summary = run.summary;
    if (summary && !state.lines.join("\n").includes(summary)) state.lines.push("", `CEO final review:\n${summary}`);
    return result(state, true, "completed", summary);
  }
  if (run?.status === "awaiting_approval") {
    const detail = run.summary ?? "Approval required before this run can continue.";
    state.lines.push("", `Run awaiting approval: ${detail}`);
    return result(state, true, "awaiting_approval", run.summary, detail);
  }
  if (run?.status === "failed") {
    const detail = run.summary ?? "unknown error";
    state.lines.push("", `Run failed: ${detail}`);
    return result(state, true, "failed", run.summary, detail);
  }
  if (run?.status === "cancelled") {
    state.lines.push("", "Run cancelled.");
    return result(state, true, "cancelled");
  }
  return result(state, false, run?.status, run?.summary);
}

function appendPlan(state: OrchestrationTranscriptState, count: number): void {
  if (state.planAnnounced) return;
  state.lines.push(`Plan ready${count ? `: ${count} steps` : ""}.`);
  state.planAnnounced = true;
}

function appendStart(state: OrchestrationTranscriptState, step?: CommandStepPayload): void {
  if (!step?.id || state.seenStarts.has(step.id)) return;
  state.seenStarts.add(step.id);
  state.lines.push(`\n${step.agentRole ?? "agent"} started: ${step.title ?? step.id}`);
}

function appendOutput(state: OrchestrationTranscriptState, step?: CommandStepPayload): void {
  if (!step?.id || state.seenOutputs.has(step.id)) return;
  state.seenOutputs.add(step.id);
  state.lines.push(
    "",
    `### ${step.agentRole ?? "agent"} report - ${step.title ?? step.id}`,
    step.output?.trim() || "No output returned.",
  );
}

function appendCritic(state: OrchestrationTranscriptState, step?: CommandStepPayload): void {
  if (!step?.id || state.seenCritiques.has(step.id)) return;
  const critique = step.critique;
  if (!critique) return;
  state.seenCritiques.add(step.id);
  const verdict = critique.verdict ?? "review";
  const reason = critique.reason ?? "No reason recorded.";
  state.lines.push("", `Critic review - ${step.agentRole ?? "agent"} / ${step.title ?? step.id}`, `${verdict}: ${reason}`);
  if (critique.improvement) state.lines.push(`Improvement: ${critique.improvement}`);
}

function appendNotice(
  state: OrchestrationTranscriptState,
  label: string,
  step?: CommandStepPayload,
  detail?: string,
): void {
  const key = `${label}:${step?.id ?? "run"}:${detail ?? ""}`;
  if (state.seenNotices.has(key)) return;
  state.seenNotices.add(key);
  state.lines.push("", `${label} - ${step?.agentRole ?? "agent"} / ${step?.title ?? step?.id ?? "run"}`, detail ?? "No detail recorded.");
}

function approvalDetail(step?: CommandStepPayload, detail?: string): string {
  const approval = step?.approvalId ? `approval ${step.approvalId}` : undefined;
  return [detail, approval].filter(Boolean).join(" · ") || "Approval required.";
}

function result(
  state: OrchestrationTranscriptState,
  done: boolean,
  runStatus?: string,
  summary?: string,
  detail?: string,
): OrchestrationTranscriptResult {
  return { content: state.lines.join("\n"), done, runStatus, summary, detail };
}

function asStep(value: unknown): CommandStepPayload | null {
  if (!value || typeof value !== "object") return null;
  const step = value as CommandStepPayload;
  return typeof step.id === "string" ? step : null;
}
