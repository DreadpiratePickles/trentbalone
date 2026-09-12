import { describe, expect, it, vi } from "vitest";
import {
  MARKETING_PLATFORMS,
  PLATFORM_CAPABILITY_KEYS,
  REQUIRED_ADAPTER_METHODS,
  isMarketingPlatform,
  type MarketingPlatformAdapter,
} from "./platform-adapter";

describe("MarketingPlatformAdapter contract", () => {
  it("defines the supported marketing platforms", () => {
    expect(MARKETING_PLATFORMS).toEqual(["meta", "google", "tiktok", "linkedin", "reddit"]);
    expect(isMarketingPlatform("meta")).toBe(true);
    expect(isMarketingPlatform("twitter")).toBe(false);
  });

  it("requires all Task 3 adapter methods", () => {
    expect(REQUIRED_ADAPTER_METHODS).toEqual([
      "createCampaignDraft",
      "createAdSet",
      "createCreative",
      "ensureConversionSource",
      "sendConversionEvent",
      "fetchInsights",
      "pauseCampaign",
      "setBudget",
    ]);
  });

  it("exposes the complete capability matrix shape", () => {
    const adapter: MarketingPlatformAdapter = {
      platform: "meta",
      capabilities: {
        campaignDrafts: true,
        conversionSource: true,
        serverEvents: true,
        insights: true,
        budgetUpdates: true,
        pauseCampaigns: true,
      },
      createCampaignDraft: vi.fn(),
      createAdSet: vi.fn(),
      createCreative: vi.fn(),
      ensureConversionSource: vi.fn(),
      sendConversionEvent: vi.fn(),
      fetchInsights: vi.fn(),
      pauseCampaign: vi.fn(),
      setBudget: vi.fn(),
    };

    expect(Object.keys(adapter.capabilities)).toEqual(PLATFORM_CAPABILITY_KEYS);
  });
});
