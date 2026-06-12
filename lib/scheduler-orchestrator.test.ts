import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

const { mockRunCompanyCycle, mockLaunchOrchestration } = vi.hoisted(() => ({
  mockRunCompanyCycle: vi.fn(),
  mockLaunchOrchestration: vi.fn(),
}));

vi.mock("@/lib/cycles", () => ({
  runCompanyCycle: mockRunCompanyCycle,
}));

vi.mock("@/lib/orchestrator", () => ({
  launchOrchestration: mockLaunchOrchestration,
}));

import { runDueScheduledCycles } from "@/lib/scheduler";

describe("runDueScheduledCycles durable engine", () => {
  beforeEach(() => {
    mockRunCompanyCycle.mockReset();
    mockLaunchOrchestration.mockReset();
  });

  it("launches the durable orchestrator for due scheduled cycles instead of the legacy linear runner", async () => {
    const company = await store.createCompany({
      name: `Scheduler Orchestrator ${makeId("test")}`,
      brief: { vision: "Run only the durable cycle engine" },
      cycleFrequency: "daily",
    });
    await store.updateCompany(company.id, {
      nextCycleAt: "2026-06-11T00:00:00.000Z",
    });
    mockRunCompanyCycle.mockImplementation(() => {
      throw new Error("legacy runCompanyCycle should not be called");
    });
    mockLaunchOrchestration.mockResolvedValue({
      id: "orc_scheduled",
      cycleId: "cycle_scheduled",
      companyId: company.id,
      objective: "Inspect company state",
      status: "planning",
      steps: [],
      startedAt: "2026-06-12T00:00:00.000Z",
      trigger: "scheduled",
      fullTeam: true,
    });

    const results = await runDueScheduledCycles("2026-06-12T00:00:00.000Z", [company.id]);

    expect(mockRunCompanyCycle).not.toHaveBeenCalled();
    expect(mockLaunchOrchestration).toHaveBeenCalledWith({
      companyId: company.id,
      objective: expect.stringContaining("scheduled operating cycle"),
      trigger: "scheduled",
      fullTeam: true,
      cycleKind: "scheduled",
    });
    expect(results).toEqual([expect.objectContaining({ id: "orc_scheduled", cycleId: "cycle_scheduled" })]);
  });
});
