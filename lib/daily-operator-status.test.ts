import { describe, expect, it } from "vitest";
import { buildDailyOperatorStatus } from "@/lib/daily-operator-status";
import type { Company } from "@/lib/types";

function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "co_1",
    name: "Trench OS",
    slug: "trench-os",
    status: "active",
    autonomyLevel: "autonomous_with_approvals",
    publicVisibility: false,
    publicSubdomain: "trench",
    timezone: "UTC",
    budgetCents: 10000,
    cycleFrequency: "daily",
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    brief: { vision: "x", icp: "", offer: "", pricing: "", competitors: "", brandVoice: "", goals: "", constraints: "", successMetrics: "" },
    metrics: { users: 0, signups: 0, revenueCents: 0, conversionRate: 0, retentionRate: 0 },
    ...overrides,
  };
}

describe("buildDailyOperatorStatus", () => {
  it("shows disabled operator mode when no nightly hour is configured", () => {
    expect(buildDailyOperatorStatus(company(), "2026-06-15T12:00:00.000Z")).toMatchObject({
      enabled: false,
      label: "manual only",
      nextRunAt: undefined,
    });
  });

  it("computes the next nightly durable cycle and morning email status", () => {
    const status = buildDailyOperatorStatus(
      company({ nightlyRunHour: 6, lastCycleAt: "2026-06-15T06:05:00.000Z" }),
      "2026-06-15T12:00:00.000Z",
    );

    expect(status).toMatchObject({
      enabled: true,
      label: "nightly durable operator",
      lastRunAt: "2026-06-15T06:05:00.000Z",
      nextRunAt: "2026-06-16T06:00:00.000Z",
      morningEmail: "assembled after the nightly cycle",
      approvalQueue: "risky actions become founder approvals",
    });
  });
});
