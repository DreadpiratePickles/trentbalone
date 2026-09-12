import type { ActivityStep } from "@/components/agent-activity/types";
import { mapOrcEventName } from "@/components/agent-activity/mappers/orc-event";

export type TraceTimelineItem = {
  id: string;
  seq: number;
  kind: string;
  seat?: string;
  status?: string;
  title?: string;
  detail?: string;
  payload?: Record<string, unknown>;
};

export function mapTraceTimelineItem(item: TraceTimelineItem): ActivityStep {
  if (item.kind === "handoff_event") return mapHandoffTimelineItem(item);

  const mapped = mapOrcEventName(item.kind, {
    step: {
      id: item.id,
      title: item.title,
      agentRole: item.seat,
      status: item.status,
      output: item.detail,
    },
    detail: item.detail,
  }, item.seq);

  if (mapped) return { ...mapped, id: item.id };

  return {
    id: item.id,
    icon: "status",
    verb: item.kind.replace(/_/g, " "),
    target: item.title ?? item.detail,
    chip: item.seat ? `${item.seat} · ${item.status ?? "event"}` : item.status,
    status: item.status === "failed" || item.status === "blocked" ? "failed" : "completed",
    narration: item.detail,
  };
}

function mapHandoffTimelineItem(item: TraceTimelineItem): ActivityStep {
  const payload = item.payload ?? {};
  const from = readString(payload.from) ?? item.seat ?? "agent";
  const to = readString(payload.to) ?? "agent";
  const severity = readString(payload.severity) ?? item.status ?? "green";
  const summary = readString(payload.summary) ?? item.detail;
  const nextActions = readStringList(payload.nextActions);
  const risks = readStringList(payload.risks);
  const notDone = readStringList(payload.whatIDidNotDo);
  const payloadRef = readString(payload.payloadRef);
  const contractVersion = readString(payload.contractVersion);

  return {
    id: item.id,
    icon: "narration",
    verb: "Handoff",
    target: `${from} -> ${to}`,
    chip: severity,
    status: severity === "red" || item.status === "failed" ? "failed" : "completed",
    narration: [
      summary ? `SUMMARY: ${summary}` : "",
      listSection("NEXT ACTIONS", nextActions),
      listSection("RISKS", risks),
      listSection("NOT DONE", notDone),
      payloadRef ? `PAYLOAD: ${payloadRef}` : "",
      contractVersion ? `CONTRACT: ${contractVersion}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function listSection(title: string, items: string[]): string {
  if (!items.length) return "";
  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
