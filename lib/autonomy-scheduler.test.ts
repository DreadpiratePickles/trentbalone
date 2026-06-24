import { describe, expect, it, vi } from "vitest";
import {
  autonomySweepEnabled,
  parseCompanyAllowlist,
  runAutonomousSweep,
  selectAutonomousCompanies,
} from "./autonomy-scheduler";
import type { Company, CompanyAutonomyMode } from "@/lib/types";
import type { HeartbeatReport } from "@/lib/heartbeat";

function company(id: string, mode: CompanyAutonomyMode | undefined, status = "active"): Company {
  // Autonomy mode lives in brief.autonomy (read via getCompanyAutonomySettings);
  // when unset it derives from the legacy autonomyLevel (review_only → manual).
  return {
    id,
    status,
    autonomyLevel: "review_only",
    brief: mode ? { autonomy: { mode } } : {},
  } as unknown as Company;
}

describe("autonomySweepEnabled / allowlist", () => {
  it("is off by default and on only with the explicit flag", () => {
    expect(autonomySweepEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(autonomySweepEnabled({ AUTONOMY_SWEEP_ENABLED: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(autonomySweepEnabled({ AUTONOMY_SWEEP_ENABLED: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("parses a comma-separated company allowlist", () => {
    expect(parseCompanyAllowlist({ AUTONOMY_SWEEP_COMPANY_IDS: " a , b ,," } as unknown as NodeJS.ProcessEnv)).toEqual(["a", "b"]);
    expect(parseCompanyAllowlist({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("selectAutonomousCompanies", () => {
  const companies = [
    company("auto1", "autonomous"),
    company("manual1", "manual"),
    company("supervised1", "supervised"),
    company("none1", undefined),
    company("autoPaused", "autonomous", "paused"),
    company("auto2", "autonomous"),
  ];

  it("selects only active companies explicitly in autonomous mode", () => {
    const ids = selectAutonomousCompanies(companies).map((c) => c.id);
    expect(ids).toEqual(["auto1", "auto2"]); // manual/supervised/none/paused excluded
  });

  it("honors an allowlist for scoped first-run validation", () => {
    const ids = selectAutonomousCompanies(companies, { allowlist: ["auto2"] }).map((c) => c.id);
    expect(ids).toEqual(["auto2"]);
  });
});

describe("runAutonomousSweep", () => {
  it("runs the heartbeat only for eligible companies and tallies decisions", async () => {
    const runHeartbeat = vi.fn(async (c: Company): Promise<HeartbeatReport> => {
      if (c.id === "auto1") return { companyId: c.id, decision: "act", reason: "overdue", runId: "run_1" };
      return { companyId: c.id, decision: "monitor", reason: "healthy" };
    });
    const listCompanies = vi.fn(async () => [
      company("auto1", "autonomous"),
      company("manual1", "manual"),
      company("auto2", "autonomous"),
    ]);

    const summary = await runAutonomousSweep({ deps: { listCompanies, runHeartbeat } });

    expect(summary).toMatchObject({ eligible: 2, acted: 1, monitored: 1, skipped: 0 });
    expect(runHeartbeat).toHaveBeenCalledTimes(2); // manual1 never touched
    expect(runHeartbeat.mock.calls.map((c) => c[0].id)).toEqual(["auto1", "auto2"]);
  });

  it("isolates a failing company without aborting the sweep", async () => {
    const runHeartbeat = vi.fn(async (c: Company): Promise<HeartbeatReport> => {
      if (c.id === "boom") throw new Error("orchestrator exploded");
      return { companyId: c.id, decision: "monitor", reason: "healthy" };
    });
    const listCompanies = vi.fn(async () => [company("boom", "autonomous"), company("ok", "autonomous")]);

    const summary = await runAutonomousSweep({ deps: { listCompanies, runHeartbeat } });

    expect(summary.eligible).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.monitored).toBe(1);
    expect(summary.reports.find((r) => r.companyId === "boom")?.reason).toContain("orchestrator exploded");
  });
});
