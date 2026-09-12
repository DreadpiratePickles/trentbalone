import type { ActivityStep } from "@/components/agent-activity/types";
import { makeStepId } from "@/components/agent-activity/utils";

export type MissionEventInput = {
  id: string;
  seq: number;
  kind: string;
  stepId?: string;
  payload: Record<string, unknown>;
};

export function mapMissionEvent(event: MissionEventInput): ActivityStep {
  const payload = event.payload;
  const detail = stringField(payload.detail)
    ?? stringField(payload.summary)
    ?? stringField(payload.title)
    ?? stringField(payload.gate)
    ?? summarizeBlockers(payload);

  const base = {
    id: event.id || makeStepId("mission", event.seq, event.kind),
    chip: event.stepId ? `step ${event.stepId}` : undefined,
  };

  switch (event.kind) {
    case "run_start":
      return { ...base, icon: "status", verb: "Mission started", target: detail, status: "running" };
    case "plan_ready":
      return { ...base, icon: "plan", verb: "Plan ready", chip: detail, status: "completed" };
    case "step_start":
      return { ...base, icon: "status", verb: "Running step", target: detail, status: "running" };
    case "step_output":
      return {
        ...base,
        icon: "narration",
        verb: "Step output",
        target: detail,
        status: "completed",
        narration: detail,
        code: detail ? { content: detail, language: "markdown" } : undefined,
      };
    case "step_blocked":
      return { ...base, icon: "error", verb: "Blocked", target: detail, status: "failed" };
    case "step_awaiting_approval":
    case "approval_requested":
      return {
        ...base,
        icon: "approval",
        verb: "Awaiting approval",
        target: detail,
        chip: event.kind,
        status: "waiting",
      };
    case "approval_resolved":
      return { ...base, icon: "approval", verb: "Approval resolved", target: detail, status: "completed" };
    case "artifact_created":
      return { ...base, icon: "write", verb: "Artifact created", target: stringField(payload.artifactId) ?? detail, status: "completed" };
    case "run_done":
      return { ...base, icon: "done", verb: "Mission complete", target: detail, chip: "passed", status: "completed" };
    case "run_failed":
      return { ...base, icon: "error", verb: "Mission failed", target: detail, status: "failed" };
    default:
      return {
        ...base,
        icon: "status",
        verb: event.kind.replace(/_/g, " "),
        target: detail ?? stringField(payload.artifactId),
        status: "completed",
      };
  }
}

export function mapMissionSteps(
  steps: Array<{ id: string; seq: number; agentRole: string; title: string; status: string; output?: string }>,
): ActivityStep[] {
  return steps.map((step) => ({
    id: `mission-step-${step.id}`,
    icon: step.status === "awaiting_approval" ? "approval" : step.status === "failed" ? "error" : "status",
    verb: step.status === "completed" ? "Completed" : step.status === "running" ? "Running" : "Step",
    target: `${step.agentRole} · ${step.title}`,
    chip: step.status,
    status: step.status === "failed" || step.status === "blocked"
      ? "failed"
      : step.status === "awaiting_approval"
        ? "waiting"
        : step.status === "running"
          ? "running"
          : "completed",
    narration: step.output,
  }));
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function summarizeBlockers(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.blockers)) return undefined;
  const items = payload.blockers.filter((item): item is string => typeof item === "string");
  return items.length ? items.join("; ") : undefined;
}
