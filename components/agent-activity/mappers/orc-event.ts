import type { ActivityStep } from "@/components/agent-activity/types";
import { makeStepId } from "@/components/agent-activity/utils";

export type OrcStepPayload = {
  id?: string;
  title?: string;
  agentRole?: string;
  status?: string;
  output?: string;
  critique?: { verdict?: string; reason?: string; improvement?: string };
};

export type OrcStreamInput = {
  kind?: string;
  step?: OrcStepPayload;
  run?: { steps?: unknown[]; summary?: string; status?: string };
  preflight?: {
    autonomy?: { mode?: string };
    toolReadiness?: { connected?: number; needsCredentials?: number; failed?: number; unavailable?: number };
  };
  detail?: string;
};

export function mapOrcEventName(eventName: string, payload: OrcStreamInput, index: number): ActivityStep | null {
  const step = payload.step;
  const seat = step?.agentRole ?? "agent";
  const title = step?.title ?? step?.id ?? "step";

  switch (eventName) {
    case "run_preflight": {
      const tools = payload.preflight?.toolReadiness;
      return {
        id: makeStepId("orc", index, "preflight"),
        icon: "verify",
        verb: "Preflight ready",
        target: payload.preflight?.autonomy?.mode ? `autonomy ${payload.preflight.autonomy.mode}` : "readiness snapshot",
        chip: tools ? `${tools.connected ?? 0} connected` : undefined,
        status: "completed",
      };
    }
    case "plan_start":
      return { id: makeStepId("orc", index, "plan"), icon: "plan", verb: "Planning", status: "running" };
    case "plan_end": {
      const count = Array.isArray(payload.run?.steps) ? payload.run!.steps!.length : 0;
      return {
        id: makeStepId("orc", index, "plan-end"),
        icon: "plan",
        verb: "Plan ready",
        chip: count ? `${count} steps` : undefined,
        status: "completed",
      };
    }
    case "step_start":
      return {
        id: step?.id ?? makeStepId("orc", index, "start"),
        icon: "status",
        verb: "Running",
        target: `${seat} · ${title}`,
        status: "running",
      };
    case "step_output":
      return {
        id: `${step?.id ?? makeStepId("orc", index)}-output`,
        icon: "narration",
        verb: "Report",
        target: `${seat} · ${title}`,
        chip: "delivered",
        status: "completed",
        narration: step?.output?.trim() || "No output returned.",
        code: step?.output?.trim()
          ? { content: step.output.trim(), language: "markdown", filename: `${seat}-report.md` }
          : undefined,
      };
    case "step_critic": {
      const verdict = step?.critique?.verdict ?? "review";
      const failed = verdict === "fail" || verdict === "blocked";
      return {
        id: `${step?.id ?? makeStepId("orc", index)}-critic`,
        icon: "verify",
        verb: "Critic review",
        target: `${seat} · ${title}`,
        chip: verdict,
        status: failed ? "failed" : "completed",
        narration: [step?.critique?.reason, step?.critique?.improvement].filter(Boolean).join("\n") || undefined,
      };
    }
    case "step_end":
      return {
        id: `${step?.id ?? makeStepId("orc", index)}-end`,
        icon: "done",
        verb: "Step complete",
        target: `${seat} · ${title}`,
        chip: step?.status,
        status: step?.status === "failed" || step?.status === "blocked" ? "failed" : "completed",
      };
    case "step_blocked":
      return {
        id: makeStepId("orc", index, "blocked"),
        icon: "error",
        verb: "Blocked",
        target: `${seat} · ${title}`,
        chip: payload.detail ?? "blocked",
        status: "failed",
      };
    case "step_awaiting_approval":
      return {
        id: makeStepId("orc", index, "approval"),
        icon: "approval",
        verb: "Awaiting approval",
        target: `${seat} · ${title}`,
        chip: payload.detail ?? "approval required",
        status: "waiting",
      };
    case "step_approved":
      return {
        id: makeStepId("orc", index, "approved"),
        icon: "approval",
        verb: "Approved",
        target: `${seat} · ${title}`,
        status: "completed",
      };
    case "step_pending":
      return {
        id: makeStepId("orc", index, "pending"),
        icon: "status",
        verb: "Delegated",
        target: `${seat} · ${title}`,
        chip: payload.detail,
        status: "pending",
      };
    case "step_note":
      return {
        id: makeStepId("orc", index, "note"),
        icon: "narration",
        verb: "Note",
        target: payload.detail,
        status: "completed",
      };
    case "consolidate_start":
      return { id: makeStepId("orc", index, "consolidate"), icon: "plan", verb: "CEO consolidation", status: "running" };
    case "consolidate_end":
      return {
        id: makeStepId("orc", index, "consolidate-end"),
        icon: "narration",
        verb: "CEO summary",
        status: "completed",
        narration: payload.run?.summary,
      };
    case "run_done":
      return {
        id: makeStepId("orc", index, "done"),
        icon: "done",
        verb: "Run complete",
        chip: "passed",
        status: "completed",
        narration: payload.run?.summary,
      };
    case "run_awaiting_approval":
      return {
        id: makeStepId("orc", index, "awaiting-approval"),
        icon: "approval",
        verb: "Run awaiting approval",
        target: payload.detail ?? payload.run?.summary ?? "approval required",
        status: "waiting",
      };
    case "run_failed":
      return {
        id: makeStepId("orc", index, "failed"),
        icon: "error",
        verb: "Run failed",
        target: payload.detail ?? "unknown error",
        status: "failed",
      };
    case "run_cancelled":
      return { id: makeStepId("orc", index, "cancelled"), icon: "error", verb: "Run cancelled", status: "failed" };
    default:
      return null;
  }
}
