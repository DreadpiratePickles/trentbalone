import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAppendAuditLog, mockAssertSpendAvailable } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn(),
  mockAssertSpendAvailable: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("@/lib/spend", () => ({ assertSpendAvailable: mockAssertSpendAvailable }));

import { plan, runCycle, seatResultSchema, type SeatRunner } from "@/lib/planner";

describe("orchestration swarm regression", () => {
  beforeEach(() => {
    mockAppendAuditLog.mockReset();
    mockAssertSpendAvailable.mockReset();
    mockAssertSpendAvailable.mockResolvedValue({});
  });

  it("plans and executes the full supervised seat roster while preserving a failed sibling", async () => {
    const prompt = [
      "Prioritize strategy",
      "build the app",
      "run ads",
      "draft launch email",
      "handle support replies",
      "analyze metrics",
      "check budget",
      "research competitor website screenshots",
      "draft sales follow-up",
      "deploy after approval",
    ].join(", ");
    const subtasks = await plan({ companyId: "co_1", prompt }, "cycle_swarm");
    const plannedSeats = subtasks.map((subtask) => subtask.seat);
    expect(plannedSeats).toEqual([
      "ceo",
      "engineer",
      "growth",
      "content",
      "support",
      "finance",
      "analyst",
      "escalation",
      "sales",
    ]);

    const started: string[] = [];
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => {
        started.push(subtask.seat);
        if (subtask.seat === "support") throw new Error("support inbox unavailable");
        return seatResultSchema.parse({
          seat: subtask.seat,
          payloadRef: `artifact_${subtask.seat}`,
          confidence: 0.9,
          costCents: 5,
          workRequests: subtask.seat === "content"
            ? [{
                id: "wr_finance_copy_review",
                cycleId: "cycle_swarm",
                companyId: "co_1",
                requester: "content",
                capability: "budget check for launch email",
                input: {},
                budgetCents: 1,
                depth: 0,
              }]
            : [],
        });
      }),
    };

    const result = await runCycle({ companyId: "co_1", cycleId: "cycle_swarm", prompt }, runner);

    expect(result.status).toBe("escalated");
    expect(started.slice(0, 9)).toEqual(plannedSeats);
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ seat: "support", confidence: 0, error: "support inbox unavailable" }),
      expect.objectContaining({ seat: "finance", payloadRef: "artifact_finance" }),
    ]));
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "agent",
      "handoff",
      "handoff_event",
      "cycle_swarm",
      "content -> finance: budget check for launch email"
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "system",
      "escalate",
      "cycle",
      "cycle_swarm",
      expect.any(String)
    );
  });

  it("audits depth and spend guardrail rejections from dynamic work requests", async () => {
    mockAssertSpendAvailable.mockImplementation(async (_companyId: string, budgetCents: number) => {
      if (budgetCents > 100) throw new Error("spend cap exceeded");
      return {};
    });
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => seatResultSchema.parse({
        seat: subtask.seat,
        payloadRef: `artifact_${subtask.seat}`,
        confidence: 0.9,
        costCents: 5,
        workRequests: [{
          id: "wr_depth",
          cycleId: "cycle_guardrail",
          companyId: "co_1",
          requester: subtask.seat,
          capability: "security review",
          input: {},
          budgetCents: 1,
          depth: 3,
        }, {
          id: "wr_spend",
          cycleId: "cycle_guardrail",
          companyId: "co_1",
          requester: subtask.seat,
          capability: "paid ads campaign",
          input: {},
          budgetCents: 999,
          depth: 0,
        }],
      })),
    };

    const result = await runCycle({
      companyId: "co_1",
      cycleId: "cycle_guardrail",
      prompt: "summarize metrics",
    }, runner);

    expect(result.status).toBe("completed");
    expect(runner.run).toHaveBeenCalledOnce();
    const rejectionSummaries = mockAppendAuditLog.mock.calls
      .filter((call) => call[2] === "work_request_rejected")
      .map((call) => call[5]);
    expect(rejectionSummaries).toEqual([
      expect.stringContaining("fan-out depth"),
      "spend cap exceeded",
    ]);
  });
});
