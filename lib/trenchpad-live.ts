import type { AgentRole, WorkbenchEventStatus, WorkbenchEventType, WorkbenchSessionStatus } from "@/lib/types";
import type { TrenchpadStreamEvent } from "@/lib/workbench-event-stream";

export type TrenchpadAggregateLike = {
  companyId: string;
  headerUsage: { spentCents: number; budgetCents: number; remainingCents: number };
  sessionRail: {
    sessions: Array<{ id: string; objective: string; status: WorkbenchSessionStatus; agentRole: AgentRole; costCents: number; previewUrl?: string }>;
    filters?: string[];
    inlineRename?: boolean;
  };
  workStream: WorkStreamItem[];
  commandCenter: { reuse: string; affordances: string[] };
  rightPanel: {
    activeSessionId?: string;
    planner: { actions?: string[]; auditRequired?: boolean; steps: PlanStep[] };
    artifacts: Array<{ id: string; title: string; kind: string; storageKey: string }>;
    files: { source: string; entries: unknown[] };
    previewUrl?: string;
  };
  playbooks: { primitive?: string; actions: string[]; storage?: string };
  secrets: { scope?: string; providers?: string[]; rendersSecretValues: boolean; actions: string[]; auditRequired?: boolean };
};

export type WorkStreamItem = {
  id: string;
  sessionId: string;
  seq?: number;
  type: WorkbenchEventType | TrenchpadStreamEvent["type"];
  status: WorkbenchEventStatus | TrenchpadStreamEvent["status"];
  title: string;
  content: string;
  command?: string;
  createdAt: string;
};

export type PlanStep = {
  id: string;
  index: number;
  title: string;
  status: string;
  editable: boolean;
  approvalRequired: boolean;
};

export type LiveFile = {
  path: string;
  language?: string;
  content?: string;
  diff?: string;
  lastSeq: number;
};

export type LiveApproval = {
  id: string;
  stepId?: string;
  title: string;
  riskClass?: "reversible" | "costly" | "irreversible";
  seq: number;
};

export type TrenchpadLiveState = TrenchpadAggregateLike & {
  lastSeq: number;
  terminal: WorkStreamItem[];
  files: LiveFile[];
  selectedFilePath?: string;
  plan: { steps: PlanStep[] };
  previewUrl?: string;
  approvals: LiveApproval[];
  connection: {
    mode: "snapshot" | "streaming" | "reconnecting" | "polling";
    terminal: boolean;
  };
};

export function createTrenchpadLiveState(aggregate: TrenchpadAggregateLike): TrenchpadLiveState {
  const workStream = aggregate.workStream.slice().sort(compareWorkItems);
  const terminal = workStream.filter((event) => event.type === "shell" || event.type === "log" || event.type === "command");
  return {
    ...aggregate,
    workStream,
    terminal,
    files: [],
    plan: { steps: aggregate.rightPanel.planner.steps.slice() },
    previewUrl: aggregate.rightPanel.previewUrl,
    approvals: [],
    lastSeq: workStream.reduce((max, event) => Math.max(max, event.seq ?? 0), 0),
    connection: { mode: "snapshot", terminal: false },
  };
}

export function applyTrenchpadStreamEvent(state: TrenchpadLiveState, event: TrenchpadStreamEvent): TrenchpadLiveState {
  if (event.seq <= state.lastSeq && state.workStream.some((item) => item.seq === event.seq)) return state;

  const workItem = toWorkStreamItem(event);
  const workStream = mergeWorkStream(state.workStream, workItem);
  const terminal = isTerminalEvent(event) ? mergeWorkStream(state.terminal, workItem) : state.terminal;
  const fileState = event.type === "file_write" ? mergeFile(state, event) : { files: state.files, selectedFilePath: state.selectedFilePath };
  const plan = event.type === "plan_step" || event.type === "approval_required"
    ? { steps: mergePlanStep(state.plan.steps, event) }
    : state.plan;
  const previewUrl = event.type === "preview" && event.previewUrl ? event.previewUrl : state.previewUrl;
  const headerUsage = event.type === "cost" ? {
    spentCents: event.spentCents ?? state.headerUsage.spentCents,
    budgetCents: event.budgetCents ?? state.headerUsage.budgetCents,
    remainingCents: event.remainingCents ?? state.headerUsage.remainingCents,
  } : state.headerUsage;
  const approvals = event.type === "approval_required"
    ? mergeApproval(state.approvals, event)
    : state.approvals;

  return {
    ...state,
    headerUsage,
    workStream,
    terminal,
    files: fileState.files,
    selectedFilePath: fileState.selectedFilePath,
    plan,
    previewUrl,
    approvals,
    lastSeq: Math.max(state.lastSeq, event.seq),
    connection: {
      ...state.connection,
      terminal: event.type === "status" && ["completed", "failed", "cancelled"].includes(event.status),
    },
  };
}

function mergeWorkStream(items: WorkStreamItem[], event: WorkStreamItem): WorkStreamItem[] {
  return items
    .filter((item) => item.seq !== event.seq && item.id !== event.id)
    .concat(event)
    .sort(compareWorkItems);
}

function mergeFile(state: TrenchpadLiveState, event: TrenchpadStreamEvent) {
  const path = event.path ?? event.title;
  const nextFile: LiveFile = {
    path,
    language: event.language,
    content: event.afterContent,
    diff: event.diff,
    lastSeq: event.seq,
  };
  const files = state.files
    .filter((file) => file.path !== path)
    .concat(nextFile)
    .sort((a, b) => b.lastSeq - a.lastSeq || a.path.localeCompare(b.path));
  return { files, selectedFilePath: path };
}

function mergePlanStep(steps: PlanStep[], event: TrenchpadStreamEvent): PlanStep[] {
  const id = event.stepId ?? event.id;
  const existing = steps.find((step) => step.id === id);
  const next: PlanStep = {
    id,
    index: event.index ?? existing?.index ?? steps.length,
    title: event.title,
    status: event.status,
    editable: existing?.editable ?? true,
    approvalRequired: event.type === "approval_required" || existing?.approvalRequired === true,
  };
  return steps
    .filter((step) => step.id !== id)
    .concat(next)
    .sort((a, b) => a.index - b.index);
}

function mergeApproval(approvals: LiveApproval[], event: TrenchpadStreamEvent): LiveApproval[] {
  const approval: LiveApproval = {
    id: event.id,
    stepId: event.stepId,
    title: event.title,
    riskClass: event.riskClass,
    seq: event.seq,
  };
  return approvals.filter((item) => item.stepId !== approval.stepId).concat(approval).sort((a, b) => a.seq - b.seq);
}

function toWorkStreamItem(event: TrenchpadStreamEvent): WorkStreamItem {
  return {
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq,
    type: event.type,
    status: event.status,
    title: event.title,
    content: event.content,
    command: event.command,
    createdAt: event.createdAt,
  };
}

function isTerminalEvent(event: TrenchpadStreamEvent) {
  return event.type === "log" || event.type === "command";
}

function compareWorkItems(a: WorkStreamItem, b: WorkStreamItem) {
  return (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt.localeCompare(b.createdAt);
}
