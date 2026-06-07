import { describe, expect, it } from "vitest";
import {
  applyOrchestrationTranscriptEvent,
  createOrchestrationTranscript,
} from "@/lib/command-orchestration-transcript";

describe("Command orchestration transcript", () => {
  it("renders completed work from the initial snapshot", () => {
    const state = createOrchestrationTranscript("orc_1");

    const result = applyOrchestrationTranscriptEvent(state, "snapshot", {
      id: "orc_1",
      status: "running",
      steps: [
        { id: "s1", agentRole: "ceo", title: "Scope objective", status: "completed", output: "Scoped." },
        { id: "s2", agentRole: "engineer", title: "Build the app", status: "completed", output: "Built a Vite app." },
      ],
    });

    expect(result.content).toContain("Plan ready: 2 steps.");
    expect(result.content).toContain("### ceo report - Scope objective");
    expect(result.content).toContain("### engineer report - Build the app");
    expect(result.done).toBe(false);
  });

  it("does not duplicate a step output already rendered from snapshot", () => {
    const state = createOrchestrationTranscript("orc_1");
    applyOrchestrationTranscriptEvent(state, "snapshot", {
      id: "orc_1",
      status: "running",
      steps: [{ id: "s1", agentRole: "ceo", title: "Scope objective", status: "completed", output: "Scoped." }],
    });

    const result = applyOrchestrationTranscriptEvent(state, "step_output", {
      step: { id: "s1", agentRole: "ceo", title: "Scope objective", output: "Scoped." },
    });

    expect(result.content.match(/### ceo report/g)).toHaveLength(1);
  });

  it("marks the transcript done when a completed snapshot is received", () => {
    const state = createOrchestrationTranscript("orc_1");

    const result = applyOrchestrationTranscriptEvent(state, "snapshot", {
      id: "orc_1",
      status: "completed",
      summary: "CEO final review.",
      steps: [{ id: "s1", agentRole: "sales", title: "Draft outreach", status: "completed", output: "Drafted." }],
    });

    expect(result.done).toBe(true);
    expect(result.runStatus).toBe("completed");
    expect(result.content).toContain("CEO final review.");
  });

  it("renders critic, approval, blocker, and delegation events in the live transcript", () => {
    const state = createOrchestrationTranscript("orc_1");

    applyOrchestrationTranscriptEvent(state, "step_critic", {
      step: {
        id: "s1",
        agentRole: "engineer",
        title: "Build notes app",
        critique: { verdict: "retry", reason: "Preview was blank", improvement: "Fix the root mount" },
      },
    });
    applyOrchestrationTranscriptEvent(state, "step_awaiting_approval", {
      step: { id: "s2", agentRole: "growth", title: "Publish launch post", approvalId: "approval_1" },
    });
    applyOrchestrationTranscriptEvent(state, "step_blocked", {
      step: { id: "s3", agentRole: "finance", title: "Launch Meta ads", status: "blocked" },
      detail: "Budget approval required",
    });
    const result = applyOrchestrationTranscriptEvent(state, "step_note", {
      step: { id: "s4", agentRole: "ceo", title: "Route delegated task" },
      detail: "delegation skipped: set-okrs-goals - same-seat loop",
    });

    expect(result.content).toContain("Critic review - engineer / Build notes app");
    expect(result.content).toContain("retry: Preview was blank");
    expect(result.content).toContain("Improvement: Fix the root mount");
    expect(result.content).toContain("Awaiting approval - growth / Publish launch post");
    expect(result.content).toContain("approval_1");
    expect(result.content).toContain("Blocked - finance / Launch Meta ads");
    expect(result.content).toContain("Budget approval required");
    expect(result.content).toContain("Note - ceo / Route delegated task");
    expect(result.content).toContain("same-seat loop");
  });
});
