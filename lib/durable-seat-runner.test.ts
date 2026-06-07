import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockEnqueueSubtaskRun, mockGetJobRun } = vi.hoisted(() => ({
  mockEnqueueSubtaskRun: vi.fn(),
  mockGetJobRun: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({
  enqueueSubtaskRun: mockEnqueueSubtaskRun,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getJobRun: mockGetJobRun,
  },
}));

import { DurableSeatRunner } from "@/lib/durable-seat-runner";
import type { Subtask } from "@/lib/planner";

describe("DurableSeatRunner", () => {
  beforeEach(() => {
    mockEnqueueSubtaskRun.mockReset();
    mockGetJobRun.mockReset();
  });

  it("returns a completed persisted seat result from a run_subtask job", async () => {
    mockEnqueueSubtaskRun.mockResolvedValue({ id: "job_1" });
    mockGetJobRun.mockResolvedValue({
      id: "job_1",
      status: "completed",
      metadata: {
        result: {
          seat: "analyst",
          payloadRef: "artifact_1",
          confidence: 0.88,
          costCents: 10,
          workRequests: [],
        },
      },
    });
    const runner = new DurableSeatRunner("co_1", { pollMs: 1, maxWaitMs: 50 });

    const result = await runner.run(subtask("sub_1"));

    expect(mockEnqueueSubtaskRun).toHaveBeenCalledWith({
      companyId: "co_1",
      subtask: expect.objectContaining({ id: "sub_1" }),
      trigger: "system",
    });
    expect(result).toMatchObject({ seat: "analyst", payloadRef: "artifact_1", confidence: 0.88 });
  });

  it("returns a low-confidence result when the durable job fails", async () => {
    mockEnqueueSubtaskRun.mockResolvedValue({ id: "job_2" });
    mockGetJobRun.mockResolvedValue({ id: "job_2", status: "failed", error: "worker crashed", metadata: {} });
    const runner = new DurableSeatRunner("co_1", { pollMs: 1, maxWaitMs: 50 });

    const result = await runner.run(subtask("sub_2"));

    expect(result).toMatchObject({
      seat: "analyst",
      payloadRef: "",
      confidence: 0,
      costCents: 0,
      error: "worker crashed",
      workRequests: [],
    });
  });
});

function subtask(id: string): Subtask {
  return {
    id,
    seat: "analyst",
    objective: "Summarize metrics",
    outputContractId: "analyst.v1",
    toolGuidance: [],
    boundaries: [],
    input: {},
    contextBundle: {},
    classification: { type: "analysis", complexity: "standard", reversibility: "reversible" },
    budgetCents: 10,
  };
}
