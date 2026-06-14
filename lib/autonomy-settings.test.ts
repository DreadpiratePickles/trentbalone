import { describe, expect, it } from "vitest";
import {
  defaultAutonomySettings,
  getCompanyAutonomySettings,
  mergeAutonomySettings,
  modeFromLegacyAutonomyLevel,
  normalizeAutonomySettings,
} from "@/lib/autonomy-settings";
import type { Company } from "@/lib/types";

describe("autonomy settings defaults", () => {
  it("defaults to supervised with safe gates", () => {
    const d = defaultAutonomySettings();
    expect(d.mode).toBe("supervised");
    expect(d.approvalRequiredForExternalWrites).toBe(true);
    expect(d.approvalRequiredForSpend).toBe(true);
    expect(d.reversibleToolsAllowed).toBe(true);
    expect(d.maxAutonomousToolCallsPerRun).toBe(10);
  });
});

describe("modeFromLegacyAutonomyLevel", () => {
  it("maps the legacy 4-value level onto the 3 modes", () => {
    expect(modeFromLegacyAutonomyLevel("review_only")).toBe("manual");
    expect(modeFromLegacyAutonomyLevel("assisted")).toBe("supervised");
    // approval-heavy legacy default maps conservatively to supervised
    expect(modeFromLegacyAutonomyLevel("autonomous_with_approvals")).toBe("supervised");
    expect(modeFromLegacyAutonomyLevel("autonomous_within_limits")).toBe("autonomous");
    expect(modeFromLegacyAutonomyLevel(undefined)).toBe("supervised");
  });
});

describe("getCompanyAutonomySettings", () => {
  it("returns explicit brief.autonomy when present", () => {
    const company = {
      autonomyLevel: "review_only",
      brief: { autonomy: { ...defaultAutonomySettings("autonomous"), mode: "autonomous" } },
    } as unknown as Company;
    expect(getCompanyAutonomySettings(company).mode).toBe("autonomous");
  });

  it("derives the mode from the legacy autonomyLevel when no explicit settings", () => {
    const company = { autonomyLevel: "review_only", brief: {} } as unknown as Company;
    expect(getCompanyAutonomySettings(company).mode).toBe("manual");
  });
});

describe("normalizeAutonomySettings", () => {
  it("coerces an invalid mode to supervised and clamps numeric bounds", () => {
    const n = normalizeAutonomySettings({ mode: "bogus" as never, dailySpendLimitCents: -5, maxAutonomousToolCallsPerRun: -1 });
    expect(n.mode).toBe("supervised");
    expect(n.dailySpendLimitCents).toBe(0);
    expect(n.maxAutonomousToolCallsPerRun).toBe(0);
  });

  it("dedupes and trims tool scopes", () => {
    const n = normalizeAutonomySettings({ allowlistedToolScopes: [" a ", "a", "", "b"] as string[] });
    expect(n.allowlistedToolScopes).toEqual(["a", "b"]);
  });
});

describe("mergeAutonomySettings", () => {
  it("merges a patch, restamps updatedAt, and records the editor", () => {
    const base = defaultAutonomySettings("supervised");
    const merged = mergeAutonomySettings(base, { mode: "autonomous", dailySpendLimitCents: 500 }, "user_1");
    expect(merged.mode).toBe("autonomous");
    expect(merged.dailySpendLimitCents).toBe(500);
    expect(merged.updatedByUserId).toBe("user_1");
    expect(typeof merged.updatedAt).toBe("string");
  });
});
