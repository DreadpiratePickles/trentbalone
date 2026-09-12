import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { recordSeatEvalMeasurement } from "@/lib/seat-capability-sweep";

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

import { runDueScheduledCycles, runDueWeeklyCapabilityGateSweeps } from "@/lib/scheduler";

describe("runDueScheduledCycles durable engine", () => {
  const savedEnv = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    TRENT_FOUNDER_EMAIL: process.env.TRENT_FOUNDER_EMAIL,
  };

  beforeEach(() => {
    mockRunCompanyCycle.mockReset();
    mockLaunchOrchestration.mockReset();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.TRENT_FOUNDER_EMAIL;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
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

  it("launches the nightly durable cycle without emailing before the run completes", async () => {
    process.env.RESEND_API_KEY = "re_test_secret";
    process.env.RESEND_FROM_EMAIL = "Trent <admin@let-trent.uk>";
    process.env.TRENT_FOUNDER_EMAIL = "admin@let-trent.uk";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "email_nightly" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const company = await store.createCompany({
      name: `Nightly Orchestrator ${makeId("test")}`,
      brief: { vision: "Run nightly and email founder" },
      cycleFrequency: "manual",
    });
    await store.updateCompany(company.id, {
      nightlyRunHour: 5,
      lastCycleAt: undefined,
      nextCycleAt: undefined,
    });
    mockLaunchOrchestration.mockResolvedValue({
      id: "orc_nightly",
      cycleId: "cycle_nightly",
      companyId: company.id,
      objective: "Inspect company state",
      status: "planning",
      steps: [],
      startedAt: "2026-06-12T05:00:00.000Z",
      trigger: "scheduled",
      fullTeam: true,
    });

    const results = await runDueScheduledCycles("2026-06-12T05:15:00.000Z", [company.id]);

    expect(results).toEqual([expect.objectContaining({ id: "orc_nightly" })]);
    expect(mockLaunchOrchestration).toHaveBeenCalledWith(expect.objectContaining({
      companyId: company.id,
      trigger: "scheduled",
      fullTeam: true,
      cycleKind: "scheduled",
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
    const audits = await store.listAuditLogs(company.id);
    expect(audits).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "morning_briefing.email_sent" }),
    ]));
  });

  it("runs a due weekly capability gate sweep from measured seat eval scores", async () => {
    const company = await store.createCompany({
      name: `Weekly Capability ${makeId("test")}`,
      brief: { vision: "Promote only measured seats" },
      cycleFrequency: "manual",
    });
    await recordSeatEvalMeasurement({
      companyId: company.id,
      role: "engineer",
      score: 96,
      criticFlagRate: 0,
      evaluatedAt: "2026-06-12T00:00:00.000Z",
    });

    const jobs = await runDueWeeklyCapabilityGateSweeps("2026-06-13T00:00:00.000Z", [company.id]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe("weekly_capability_sweep");
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.resultCount).toBe(1);
    expect(jobs[0]?.metadata.result).toMatchObject({ recorded: 1, skipped: 8 });
    const audits = await store.listAuditLogs(company.id);
    expect(audits.some((audit) =>
      audit.action === "agent.capability_gate" &&
      audit.summary.includes("engineer promoted to autonomous")
    )).toBe(true);
  });
});
