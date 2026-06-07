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
};

export function mapTraceTimelineItem(item: TraceTimelineItem): ActivityStep {
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
