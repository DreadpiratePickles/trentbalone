import { describe, expect, it } from "vitest";
import {
  buildClaudeAdsCommandPlan,
  buildClaudeAdsToolScopes,
  normalizeClaudeAdsAction,
} from "@/lib/claude-ads";

describe("Claude Ads integration helpers", () => {
  it("declares audit and critique scopes for the critic pass", () => {
    expect(buildClaudeAdsToolScopes()).toEqual([
      "claude_ads:audit",
      "claude_ads:platform_review",
      "claude_ads:creative_review",
      "claude_ads:budget_review",
      "claude_ads:landing_review",
      "claude_ads:report",
    ]);
  });

  it("normalizes common critic actions to /ads commands", () => {
    expect(normalizeClaudeAdsAction("creative fatigue review")).toBe("creative");
    expect(normalizeClaudeAdsAction("budget allocation critique")).toBe("budget");
    expect(normalizeClaudeAdsAction("landing page audit")).toBe("landing");
    expect(normalizeClaudeAdsAction("full paid media audit")).toBe("audit");
  });

  it("builds command plans without executing ad-platform changes", () => {
    expect(buildClaudeAdsCommandPlan("audit", { platform: "meta", businessType: "saas" })).toEqual([
      "/ads",
      "meta",
      "--business-type",
      "saas",
    ]);
    expect(buildClaudeAdsCommandPlan("report", { output: "ADS-AUDIT-REPORT.md" })).toEqual([
      "/ads",
      "report",
      "--output",
      "ADS-AUDIT-REPORT.md",
    ]);
  });
});
