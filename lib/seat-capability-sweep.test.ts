import { describe, expect, it } from "vitest";
import { clearAgentRuntimeCache, getAgentRuntime } from "@/lib/agent-runtime";
import {
  recordSeatEvalMeasurement,
  runWeeklySeatCapabilityGateSweep,
} from "@/lib/seat-capability-sweep";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("weekly seat capability sweep", () => {
  it("records measured eval decisions and skips seats without measurements", async () => {
    const company = await store.createCompany({
      name: `Capability Sweep ${makeId("test")}`,
      brief: { vision: "Run weekly seat eval gates from measured scores" },
    });
    await recordSeatEvalMeasurement({
      companyId: company.id,
      role: "engineer",
      score: 96,
      criticFlagRate: 0,
      evaluatedAt: "2026-06-13T02:00:00.000Z",
    });

    const report = await runWeeklySeatCapabilityGateSweep({
      companyId: company.id,
      atIso: "2026-06-13T02:30:00.000Z",
      roles: ["engineer", "growth"],
    });
    clearAgentRuntimeCache();
    const runtime = await getAgentRuntime(company.id, "engineer");
    const audits = await store.listAuditLogs(company.id);

    expect(report.recorded).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "engineer", status: "recorded", action: "promote", qualityLabel: "autonomous" }),
      expect.objectContaining({ role: "growth", status: "skipped", reason: expect.stringContaining("No measured seat eval score") }),
    ]));
    expect(runtime.environment.approvalRequiredFor).not.toContain("github.issue");
    expect(runtime.dynamicPrompt).toContain("CAPABILITY GATE");
    expect(audits.some((audit) =>
      audit.action === "agent.capability_gate" &&
      audit.summary.includes("engineer promoted to autonomous")
    )).toBe(true);
  });

  it("uses the newest measured eval score instead of stale passing evidence", async () => {
    const company = await store.createCompany({
      name: `Capability Freshness ${makeId("test")}`,
      brief: { vision: "Capability gates must follow the latest eval evidence" },
    });
    await recordSeatEvalMeasurement({
      companyId: company.id,
      role: "engineer",
      score: 96,
      criticFlagRate: 0,
      evaluatedAt: "2026-06-06T02:00:00.000Z",
    });
    await recordSeatEvalMeasurement({
      companyId: company.id,
      role: "engineer",
      score: 65,
      criticFlagRate: 0,
      evaluatedAt: "2026-06-13T02:00:00.000Z",
    });

    const report = await runWeeklySeatCapabilityGateSweep({
      companyId: company.id,
      atIso: "2026-06-13T02:30:00.000Z",
      roles: ["engineer"],
    });

    expect(report.results).toEqual([
      expect.objectContaining({
        role: "engineer",
        status: "recorded",
        score: 65,
        qualityLabel: "experimental",
        action: "hold",
      }),
    ]);
  });
});
