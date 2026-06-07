import type { WorkbenchEvent, WorkbenchEventStatus } from "@/lib/types";

export type TrenchpadStreamEventType =
  | "log"
  | "command"
  | "file_write"
  | "plan_step"
  | "artifact"
  | "preview"
  | "cost"
  | "approval_required"
  | "status";

export type TrenchpadStreamEvent = {
  id: string;
  sessionId: string;
  seq: number;
  type: TrenchpadStreamEventType;
  status: WorkbenchEventStatus | "queued" | "starting" | "running" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  title: string;
  content: string;
  command?: string;
  path?: string;
  language?: string;
  diff?: string;
  afterContent?: string;
  stepId?: string;
  index?: number;
  riskClass?: "reversible" | "costly" | "irreversible";
  artifactId?: string;
  previewUrl?: string;
  spentCents?: number;
  budgetCents?: number;
  remainingCents?: number;
};

type Subscriber = (event: TrenchpadStreamEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export function publishWorkbenchStreamEvent(event: WorkbenchEvent): void {
  const streamEvent = toTrenchpadStreamEvent(event);
  const sessionSubscribers = subscribers.get(event.sessionId);
  if (!sessionSubscribers) return;
  for (const subscriber of sessionSubscribers) subscriber(streamEvent);
}

export function subscribeWorkbenchStream(sessionId: string, subscriber: Subscriber): () => void {
  const sessionSubscribers = subscribers.get(sessionId) ?? new Set<Subscriber>();
  sessionSubscribers.add(subscriber);
  subscribers.set(sessionId, sessionSubscribers);
  return () => {
    sessionSubscribers.delete(subscriber);
    if (sessionSubscribers.size === 0) subscribers.delete(sessionId);
  };
}

export function toTrenchpadStreamEvent(event: WorkbenchEvent): TrenchpadStreamEvent {
  const data = parseRecord(event.content);
  const type = streamTypeFor(event, data);
  return {
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq ?? 0,
    type,
    status: statusFor(event, data),
    createdAt: event.createdAt,
    title: textValue(data.title) ?? event.title,
    content: textValue(data.content) ?? event.content,
    command: textValue(data.command) ?? event.command,
    path: textValue(data.path),
    language: textValue(data.language),
    diff: textValue(data.diff),
    afterContent: textValue(data.afterContent),
    stepId: textValue(data.stepId) ?? (type === "plan_step" || type === "approval_required" ? event.id : undefined),
    index: numberValue(data.index),
    riskClass: riskClassValue(data.riskClass),
    artifactId: textValue(data.artifactId) ?? event.artifactId,
    previewUrl: textValue(data.previewUrl),
    spentCents: numberValue(data.spentCents),
    budgetCents: numberValue(data.budgetCents),
    remainingCents: numberValue(data.remainingCents),
  };
}

export function encodeSse(event: TrenchpadStreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamTypeFor(event: WorkbenchEvent, data: Record<string, unknown>): TrenchpadStreamEventType {
  const explicitType = textValue(data.type);
  if (isStreamType(explicitType)) return explicitType;
  if (event.status === "needs_approval" || event.type === "approval") return "approval_required";
  if (event.type === "shell") return event.command ? "command" : "log";
  if (event.type === "file") return "file_write";
  if (event.type === "plan") return "plan_step";
  if (event.type === "artifact" || event.type === "screenshot" || event.type === "test") return "artifact";
  if (event.type === "browser" || event.type === "deploy") return "preview";
  return "status";
}

function statusFor(event: WorkbenchEvent, data: Record<string, unknown>): TrenchpadStreamEvent["status"] {
  const status = textValue(data.status);
  if (status && ["queued", "starting", "running", "paused", "completed", "failed", "cancelled"].includes(status)) {
    return status as TrenchpadStreamEvent["status"];
  }
  return event.status;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isStreamType(value: string | undefined): value is TrenchpadStreamEventType {
  return !!value && ["log", "command", "file_write", "plan_step", "artifact", "preview", "cost", "approval_required", "status"].includes(value);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return Number.isFinite(value) ? value as number : undefined;
}

function riskClassValue(value: unknown): TrenchpadStreamEvent["riskClass"] {
  return value === "reversible" || value === "costly" || value === "irreversible" ? value : undefined;
}
