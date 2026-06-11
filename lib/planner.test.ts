import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAppendAuditLog, mockAssertSpendAvailable } = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn(),
  mockAssertSpendAvailable: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("@/lib/spend", () => ({ assertSpendAvailable: mockAssertSpendAvailable }));

import {
  authorizeWorkRequest,
  classifyTask,
  MAX_PARALLEL_WORKERS,
  plan,
  runCycle,
  runPlannedSubtasks,
  seatResultSchema,
  subtaskSchema,
  type SeatRunner,
} from "@/lib/planner";

describe("planner orchestrator", () => {
  beforeEach(() => {
    mockAppendAuditLog.mockReset();
    mockAssertSpendAvailable.mockReset();
    mockAssertSpendAvailable.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes irreversible work upward and escalates after worker output", async () => {
    const classification = await classifyTask("deploy and publish the launch");
    expect(classification).toMatchObject({ complexity: "complex", reversibility: "irreversible" });

    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => ({ seat: subtask.seat, payloadRef: "artifact_1", confidence: 0.9, costCents: 10 })),
    };
    const result = await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "deploy and publish" }, runner);

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toContain("irreversible");
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "agent", "route_subtask", "routing_decision", "cycle_1", expect.stringContaining("analyst"));
  });

  it("records the CEO's available seat universe when routing a subtask", async () => {
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => ({ seat: subtask.seat, payloadRef: "artifact_1", confidence: 0.9, costCents: 10 })),
    };

    await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "summarize growth and finance risks" }, runner);

    const routeCall = mockAppendAuditLog.mock.calls.find((call) => call[2] === "route_subtask");
    expect(routeCall?.[5]).toContain("candidates=ceo,engineer,growth,content,support,finance,analyst,escalation,sales");
  });

  it("rejects dynamic collaboration past the fan-out cap", async () => {
    const rejection = await authorizeWorkRequest({
      id: "wr_1",
      cycleId: "cycle_1",
      companyId: "co_1",
      requester: "engineer",
      capability: "security-review",
      input: {},
      budgetCents: 10,
      depth: 3,
    });

    expect(rejection).toContain("fan-out depth");
    expect(mockAssertSpendAvailable).not.toHaveBeenCalled();
  });

  it("runs every planned subtask while capping concurrent worker fan-out", async () => {
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => {
        active++;
        maxActive = Math.max(maxActive, active);
        started.push(subtask.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return {
          seat: subtask.seat,
          payloadRef: `artifact_${subtask.id}`,
          confidence: 0.9,
          costCents: 10,
        };
      }),
    };
    const subtasks = Array.from({ length: MAX_PARALLEL_WORKERS + 3 }, (_, index) =>
      subtaskSchema.parse({
        id: `subtask_${index}`,
        seat: "analyst",
        objective: `Analyze launch signal ${index}`,
        outputContractId: "analyst.v1",
        dependsOn: [],
        spec: { acceptance: [`Analyze launch signal ${index}`], inputsFrom: [] },
        input: {},
        contextBundle: {},
        classification: { type: "general", complexity: "standard", reversibility: "reversible" },
        budgetCents: 1,
      })
    );

    const results = await runPlannedSubtasks(subtasks, runner);

    expect(results).toHaveLength(subtasks.length);
    expect(started).toEqual(subtasks.map((subtask) => subtask.id));
    expect(maxActive).toBeLessThanOrEqual(MAX_PARALLEL_WORKERS);
  });

  it("preserves sibling results when one planned subtask fails", async () => {
    const subtasks = ["subtask_ok", "subtask_fail", "subtask_after"].map((id) =>
      subtaskSchema.parse({
        id,
        seat: "analyst",
        objective: id,
        outputContractId: "analyst.v1",
        dependsOn: [],
        spec: { acceptance: [id], inputsFrom: [] },
        input: {},
        contextBundle: {},
        classification: { type: "general", complexity: "standard", reversibility: "reversible" },
        budgetCents: 1,
      })
    );
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => {
        if (subtask.id === "subtask_fail") throw new Error("analyst model unavailable");
        return seatResultSchema.parse({
          seat: subtask.seat,
          payloadRef: `artifact_${subtask.id}`,
          confidence: 0.9,
          costCents: 10,
          workRequests: [],
        });
      }),
    };

    const results = await runPlannedSubtasks(subtasks, runner);

    expect(results).toHaveLength(3);
    expect(results.map((result) => result.payloadRef)).toEqual([
      "artifact_subtask_ok",
      "",
      "artifact_subtask_after",
    ]);
    expect(results[1]).toMatchObject({
      seat: "analyst",
      confidence: 0,
      costCents: 0,
      error: "analyst model unavailable",
      workRequests: [],
    });
  });

  it("escalates instead of failing the whole cycle when a seat throws", async () => {
    const runner: SeatRunner = {
      run: vi.fn(async () => {
        throw new Error("seat timeout");
      }),
    };

    const result = await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "summarize status" }, runner);

    expect(result.status).toBe("escalated");
    expect(result.escalationReason).toContain("low combined-signal confidence");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ confidence: 0, error: "seat timeout" });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "system",
      "escalate",
      "cycle",
      "cycle_1",
      "low combined-signal confidence"
    );
  });

  it("runs dynamic work requests recursively with handoff audit entries", async () => {
    const runOrder: string[] = [];
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => {
        runOrder.push(subtask.seat);
        if (subtask.seat === "analyst") {
          return seatResultSchema.parse({
            seat: "analyst",
            payloadRef: "artifact_analyst",
            confidence: 0.9,
            costCents: 10,
            workRequests: [{
              id: "wr_content",
              cycleId: "cycle_1",
              companyId: "co_1",
              requester: "analyst",
              capability: "write launch email",
              input: {},
              budgetCents: 2,
              depth: 0,
            }],
          });
        }
        if (subtask.seat === "content") {
          return seatResultSchema.parse({
            seat: "content",
            payloadRef: "artifact_content",
            confidence: 0.9,
            costCents: 10,
            workRequests: [{
              id: "wr_finance",
              cycleId: "cycle_1",
              companyId: "co_1",
              requester: "content",
              capability: "budget check for launch",
              input: {},
              budgetCents: 2,
              depth: 1,
            }],
          });
        }
        return seatResultSchema.parse({
          seat: subtask.seat,
          payloadRef: `artifact_${subtask.seat}`,
          confidence: 0.9,
          costCents: 10,
          workRequests: [],
        });
      }),
    };

    const result = await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "summarize internal plan" }, runner);

    expect(result.status).toBe("completed");
    expect(runOrder).toEqual(["analyst", "content", "finance"]);
    expect(result.results.map((seatResult) => seatResult.seat)).toEqual(["analyst", "content", "finance"]);
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "agent",
      "handoff",
      "handoff_event",
      "cycle_1",
      "analyst -> content: write launch email"
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "agent",
      "handoff",
      "handoff_event",
      "cycle_1",
      "content -> finance: budget check for launch"
    );
  });

  it("audits rejected dynamic work requests without running them", async () => {
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => ({
        seat: subtask.seat,
        payloadRef: "artifact_analyst",
        confidence: 0.9,
        costCents: 10,
        workRequests: [{
          id: "wr_depth",
          cycleId: "cycle_1",
          companyId: "co_1",
          requester: subtask.seat,
          capability: "security review",
          input: {},
          budgetCents: 2,
          depth: 3,
        }],
      })),
    };

    const result = await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "summarize internal plan" }, runner);

    expect(result.status).toBe("completed");
    expect(runner.run).toHaveBeenCalledOnce();
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "agent",
      "work_request_rejected",
      "cycle",
      "cycle_1",
      expect.stringContaining("fan-out depth")
    );
  });

  it("plans a multi-seat launch request into role-appropriate subtasks", async () => {
    const subtasks = await plan({
      companyId: "co_1",
      cycleId: "cycle_1",
      prompt: "Build the landing page, draft launch email, run ads, check budget, handle support replies, research competitor website screenshots, and deploy after approval.",
    }, "cycle_1");

    expect(subtasks.map((subtask) => subtask.seat)).toEqual([
      "engineer",
      "growth",
      "content",
      "support",
      "finance",
      "analyst",
      "escalation",
    ]);
    expect(subtasks.every((subtask) => subtask.outputContractId === `${subtask.seat}.v1`)).toBe(true);
  });

  it("adds default dependency and acceptance spec contracts to deterministic subtasks", async () => {
    const subtasks = await plan({
      companyId: "co_1",
      prompt: "research competitor website and check budget",
    }, "cycle_1");

    expect(subtasks.length).toBeGreaterThan(0);
    for (const subtask of subtasks) {
      expect(subtask.dependsOn).toEqual([]);
      expect(subtask.spec.inputsFrom).toEqual([]);
      expect(subtask.spec.acceptance).toEqual([
        expect.stringContaining(subtask.objective),
      ]);
    }
  });

  it.each([
    ["review billing budget and refund risk", "finance"],
    ["research competitor website screenshots", "analyst"],
    ["draft sales follow-up for qualified leads", "sales"],
    ["draft customer support reply", "support"],
  ] as const)("routes %s to %s", async (prompt, expectedSeat) => {
    const subtasks = await plan({ companyId: "co_1", prompt }, "cycle_1");

    expect(subtasks.map((subtask) => subtask.seat)).toContain(expectedSeat);
  });

  it("records actual deterministic seats in routing audit entries", async () => {
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => seatResultSchema.parse({
        seat: subtask.seat,
        payloadRef: `artifact_${subtask.seat}`,
        confidence: 0.9,
        costCents: 10,
        workRequests: [],
      })),
    };

    await runCycle({ companyId: "co_1", cycleId: "cycle_1", prompt: "research competitor website and check budget" }, runner);

    const routeSummaries = mockAppendAuditLog.mock.calls
      .filter((call) => call[2] === "route_subtask")
      .map((call) => call[5]);
    expect(routeSummaries).toEqual([
      expect.stringContaining("finance via"),
      expect.stringContaining("analyst via"),
    ]);
    expect(routeSummaries.join("\n")).not.toContain("browser via");
  });

  it("does not execute an over-budget subtask plan when semantic validation is enabled", async () => {
    vi.stubEnv("ORCHESTRATION_PLAN_VALIDATOR_ENABLED", "1");
    const runner: SeatRunner = {
      run: vi.fn(async (subtask) => seatResultSchema.parse({
        seat: subtask.seat,
        payloadRef: `artifact_${subtask.seat}`,
        confidence: 0.9,
        costCents: 10,
        workRequests: [],
      })),
    };

    const result = await runCycle({
      companyId: "co_1",
      cycleId: "cycle_1",
      prompt: "research competitor website and check budget",
      context: { budgetCapCents: 1 },
    }, runner);

    expect(result.status).toBe("failed");
    expect(result.escalationReason).toContain("budget");
    expect(runner.run).not.toHaveBeenCalled();
  });
});
