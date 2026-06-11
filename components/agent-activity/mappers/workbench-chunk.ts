import type { ActivityStep } from "@/components/agent-activity/types";
import { detectLanguage, formatBytes, makeStepId, phaseLabel } from "@/components/agent-activity/utils";

export type WorkbenchChunkInput =
  | { type: "status"; phase: string; detail?: string }
  | { type: "content"; content: string }
  | { type: "plan"; steps: { kind: string; summary?: string; path?: string; command?: string }[] }
  | { type: "file"; path: string; action: string; bytes: number }
  | { type: "command"; command: string; exitCode: number; output: string }
  | { type: "test"; passed: number; failed: number; healed: boolean }
  | { type: "verify"; passed: boolean; checks: { name: string; status: string; detail: string }[] }
  | { type: "preview"; url: string }
  | { type: "error"; message: string }
  | { type: "done"; messageId: string };

type WorkbenchVerifyChunk = Extract<WorkbenchChunkInput, { type: "verify" }>;

export function mapWorkbenchChunk(chunk: WorkbenchChunkInput, index: number): ActivityStep | null {
  const id = makeStepId("wb", index, chunk.type);

  switch (chunk.type) {
    case "status":
      return {
        id,
        icon: "status",
        verb: phaseLabel(chunk.phase),
        target: chunk.detail,
        chip: chunk.phase.includes("budget") || chunk.phase === "cancelled" ? "halted" : undefined,
        status: chunk.phase === "cancelled" || chunk.phase.includes("budget") ? "failed" : "running",
      };
    case "plan":
      return {
        id,
        icon: "plan",
        verb: "Planning",
        chip: `${chunk.steps.length} step${chunk.steps.length === 1 ? "" : "s"}`,
        status: "completed",
      };
    case "file":
      return {
        id,
        icon: "write",
        verb: chunk.action === "create" ? "Writing" : "Editing",
        target: chunk.path,
        chip: formatBytes(chunk.bytes),
        status: "completed",
      };
    case "command":
      return {
        id,
        icon: "command",
        verb: "Ran",
        target: `$ ${chunk.command}`,
        chip: `exit ${chunk.exitCode}`,
        status: chunk.exitCode === 0 ? "completed" : "failed",
        code: chunk.output.trim()
          ? { content: chunk.output, language: "bash", mode: "code" }
          : undefined,
      };
    case "test":
      return {
        id,
        icon: "test",
        verb: "Tests",
        chip: `${chunk.passed} pass · ${chunk.failed} fail${chunk.healed ? " · healed" : ""}`,
        status: chunk.failed === 0 ? "completed" : "failed",
      };
    case "verify":
      return {
        id,
        icon: "verify",
        verb: "Verify",
        target: verificationTarget(chunk),
        chip: chunk.passed ? "passed" : `${chunk.checks.filter((c) => c.status === "fail").length} failed`,
        status: chunk.passed ? "completed" : "failed",
        narration: chunk.checks.length
          ? chunk.checks.map((c) => `${c.name}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
          : undefined,
      };
    case "preview":
      return {
        id,
        icon: "preview",
        verb: "Verified preview",
        target: chunk.url,
        chip: "ready",
        status: "completed",
      };
    case "error":
      return {
        id,
        icon: "error",
        verb: "Error",
        target: chunk.message,
        status: "failed",
      };
    case "done":
      return {
        id,
        icon: "done",
        verb: "Run complete",
        status: "completed",
      };
    case "content":
      return null;
    default:
      return null;
  }
}

function verificationTarget(chunk: WorkbenchVerifyChunk): string | undefined {
  const failedChecks = chunk.checks.filter((check) => check.status === "fail").map((check) => check.name);
  if (failedChecks.length) {
    const visibleChecks = failedChecks.slice(0, 3).join(", ");
    const overflow = failedChecks.length > 3 ? ` +${failedChecks.length - 3} more` : "";
    return `${visibleChecks}${overflow} failed`;
  }
  if (chunk.passed) return "all checks passed";
  return undefined;
}

export function mapWorkbenchEventsToSteps(
  events: Array<{ id: string; type: string; title: string; content: string; command?: string; status: string }>,
): ActivityStep[] {
  return events.map((event, index) => {
    if (event.type === "shell" || event.command) {
      return {
        id: event.id || makeStepId("evt", index),
        icon: "command",
        verb: "Ran",
        target: `$ ${event.command ?? event.title}`,
        chip: event.status,
        status: event.status === "failed" ? "failed" : "completed",
        code: event.content ? { content: event.content, language: "bash" } : undefined,
      };
    }
    if (event.type === "verify") {
      return {
        id: event.id || makeStepId("evt", index),
        icon: "verify",
        verb: "Verify",
        target: event.title,
        chip: event.status,
        status: event.status === "failed" ? "failed" : "completed",
        narration: event.content || undefined,
      };
    }
    return {
      id: event.id || makeStepId("evt", index),
      icon: "status",
      verb: event.title || event.type,
      target: event.content || undefined,
      chip: event.status,
      status: event.status === "failed" ? "failed" : "completed",
    };
  });
}

export function inferCodeBlock(filename: string | null, content: string): ActivityStep["code"] | undefined {
  if (!filename || !content.trim()) return undefined;
  return {
    filename,
    content,
    language: detectLanguage(filename, content),
    mode: "code",
  };
}
