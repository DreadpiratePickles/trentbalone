import { describe, expect, it } from "vitest";
import {
  buildRunCycleControl,
  mergeOrchestratorRunIntoCycleControl,
  runCycleEventReducer,
  summarizeJobRunForCycleControl,
  type RunCycleControlState,
} from "@/lib/run-cycle-control";
import type { JobRun } from "@/lib/types";

const baseState: RunCycleControlState = {
  status: "idle",
  jobId: null,
  runId: null,
  cycleId: null,
  label: null,
  error: null,
  approvalId: null,
  lastEventAt: null,
};

function job(overrides: Partial<JobRun>): JobRun {
  return {
    id: "job_1",
    type: "company_scheduled_cycle",
    status: "running",
    companyId: "co_1",
    trigger: "user",
    startedAt: "2026-06-16T10:00:00.000Z",
    summary: "Queued durable company operating cycle.",
    resultCount: 0,
    metadata: {},
    ...overrides,
  };
}

describe("run cycle control", () => {
  it("represents a queued cycle job separately from a durable run", () => {
    const state = buildRunCycleControl({ job: job({ id: "job_queued" }) });

    expect(state.status).toBe("queued");
    expect(state.jobId).toBe("job_queued");
    expect(state.runId).toBeNull();
    expect(state.label).toBe("queued");
  });

  it("reconciles a completed queue job to the launched durable run", () => {
    const state = buildRunCycleControl({
      job: job({
        id: "job_done",
        status: "completed",
        summary: "Launched durable operating cycle run_1.",
        metadata: {
          result: {
            run: {
              id: "run_1",
              cycleId: "cycle_1",
              status: "running",
            },
          },
        },
      }),
    });

    expect(state.status).toBe("running");
    expect(state.jobId).toBe("job_done");
    expect(state.runId).toBe("run_1");
    expect(state.cycleId).toBe("cycle_1");
    expect(state.label).toBe("running");
  });

  it("surfaces awaiting approval with the approval id", () => {
    const state = runCycleEventReducer(baseState, {
      status: "step",
      jobRunId: "job_1",
      at: "2026-06-16T10:01:00.000Z",
      summary: "Approval required.",
      step: {
        phase: "approval_required",
        role: "engineer",
        label: "Approval approval_123 required for deploy.",
      },
    });

    expect(state.status).toBe("awaiting_approval");
    expect(state.jobId).toBe("job_1");
    expect(state.approvalId).toBe("approval_123");
    expect(state.label).toBe("approval needed");
  });

  it("does not clear active state on transient lost contact", () => {
    const active: RunCycleControlState = {
      ...baseState,
      status: "running",
      jobId: "job_1",
      label: "engineer agent",
    };

    const state = runCycleEventReducer(active, {
      status: "lost_contact",
      at: "2026-06-16T10:02:00.000Z",
      summary: "SSE disconnected.",
    });

    expect(state.status).toBe("lost_contact");
    expect(state.jobId).toBe("job_1");
    expect(state.label).toBe("reconnecting");
  });

  it("clears only after a terminal event", () => {
    const active: RunCycleControlState = {
      ...baseState,
      status: "running",
      jobId: "job_1",
      runId: "run_1",
      label: "engineer agent",
    };

    const state = runCycleEventReducer(active, {
      status: "completed",
      jobRunId: "job_1",
      at: "2026-06-16T10:03:00.000Z",
      summary: "Completed.",
    });

    expect(state.status).toBe("completed");
    expect(state.jobId).toBe("job_1");
    expect(state.runId).toBe("run_1");
    expect(state.label).toBe("completed");
  });

  it("summarizes the latest active company scheduled cycle for polling fallback", () => {
    const summary = summarizeJobRunForCycleControl([
      job({ id: "old_done", status: "completed", completedAt: "2026-06-16T09:00:00.000Z" }),
      job({ id: "current", status: "running", startedAt: "2026-06-16T10:00:00.000Z" }),
    ]);

    expect(summary?.jobId).toBe("current");
    expect(summary?.status).toBe("queued");
  });

  it("follows the durable run status after the queue job has launched it", () => {
    const state = mergeOrchestratorRunIntoCycleControl(
      {
        ...baseState,
        status: "running",
        jobId: "job_1",
        runId: "run_1",
        cycleId: "cycle_1",
      },
      {
        id: "run_1",
        cycleId: "cycle_1",
        status: "awaiting_approval",
        updatedAt: "2026-06-16T10:04:00.000Z",
      },
    );

    expect(state.status).toBe("awaiting_approval");
    expect(state.jobId).toBe("job_1");
    expect(state.runId).toBe("run_1");
    expect(state.cycleId).toBe("cycle_1");
    expect(state.label).toBe("approval needed");
  });
});
