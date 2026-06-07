import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveCredentialEnv } = vi.hoisted(() => ({
  mockResolveCredentialEnv: vi.fn(),
}));

vi.mock("@/lib/credential-boundary", () => ({
  resolveCredentialEnv: mockResolveCredentialEnv,
  scrubSecrets: (text: string, secrets: Record<string, string>) => {
    let result = text;
    for (const value of Object.values(secrets)) {
      result = result.split(value).join("[REDACTED]");
    }
    return result;
  },
}));

import {
  MetaPlatformApiError,
  MetaGraphResponseError,
  MetaLiveOperationUnsupportedError,
  createMetaAdapter,
} from "./meta-adapter";

describe("createMetaAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCredentialEnv.mockResolvedValue({});
  });

  it("returns deterministic sandbox campaign draft refs without credentials or network calls", async () => {
    const graphFetch = vi.fn();
    const adapter = createMetaAdapter({ graphFetch });

    const draft = await adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha!",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    });

    expect(draft).toEqual({
      platform: "meta",
      externalCampaignId: "sandbox_meta_campaign_co_1_ma_1_launch_alpha",
      status: "draft",
    });
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("returns deterministic sandbox refs for non-campaign methods without network calls", async () => {
    const graphFetch = vi.fn();
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.ensureConversionSource({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Lead Pixel",
    })).resolves.toEqual({
      platform: "meta",
      externalConversionSourceId: "sandbox_meta_pixel_co_1_ma_1_lead_pixel",
      status: "sandbox",
    });
    await expect(adapter.sendConversionEvent({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      eventId: "evt_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T00:00:00Z",
    })).resolves.toEqual({
      platform: "meta",
      eventId: "evt_1",
      delivered: false,
      status: "sandbox",
    });
    await expect(adapter.fetchInsights({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
    })).resolves.toEqual({
      platform: "meta",
      impressions: 0,
      clicks: 0,
      spendCents: 0,
      conversions: 0,
    });
    await expect(adapter.pauseCampaign({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
    })).resolves.toEqual({
      platform: "meta",
      externalCampaignId: "camp_1",
      status: "sandbox",
    });
    await expect(adapter.setBudget({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
      dailyBudgetCents: 3000,
    })).resolves.toEqual({
      platform: "meta",
      externalCampaignId: "camp_1",
      status: "sandbox",
    });
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("advertises live capabilities for implemented Meta Graph methods", () => {
    const adapter = createMetaAdapter();

    expect(adapter.capabilities).toEqual({
      campaignDrafts: true,
      conversionSource: false,
      serverEvents: false,
      insights: true,
      budgetUpdates: true,
      pauseCampaigns: true,
    });
  });

  it("uses live Meta Graph only when Meta credentials exist", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "238_campaign_live" }),
    });
    const adapter = createMetaAdapter({ graphFetch });

    const draft = await adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    });

    expect(mockResolveCredentialEnv).toHaveBeenCalledWith("co_1", ["Meta"]);
    expect(graphFetch).toHaveBeenCalledWith(
      expect.stringContaining("/act_123/campaigns"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer meta_live_secret_token_12345",
        }),
      })
    );
    expect(draft.externalCampaignId).toBe("238_campaign_live");
    expect(draft.status).toBe("draft");
  });

  it("scrubs token values from thrown Meta errors", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad token meta_live_secret_token_12345",
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toBeInstanceOf(MetaPlatformApiError);
    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toThrow("bad token [REDACTED]");
  });

  it("classifies expired Meta tokens as typed provider errors", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "OAuthException: expired token meta_live_secret_token_12345",
      headers: { get: () => null },
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toMatchObject({
      code: "expired_token",
      platform: "meta",
      operation: "createCampaignDraft",
    });
    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toThrow("expired token [REDACTED]");
  });

  it("preserves Meta rate-limit retry seconds for queue backoff", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Application request limit reached",
      headers: { get: (name: string) => name.toLowerCase() === "retry-after" ? "75" : null },
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 75,
      platform: "meta",
      operation: "createCampaignDraft",
    });
  });

  it("classifies rejected Meta ad creative responses", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Ad creative was rejected by policy review",
      headers: { get: () => null },
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCreative({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      headline: "Ship faster",
      primaryText: "Let Trent do the follow-through.",
    })).rejects.toMatchObject({
      code: "rejected_ad_creative",
      platform: "meta",
      operation: "createCreative",
    });
  });

  it("throws a typed error when a live campaign draft response is missing an id", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toBeInstanceOf(MetaGraphResponseError);
    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toMatchObject({
      code: "partial_publication",
      platform: "meta",
      operation: "createCampaignDraft",
    });
    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toThrow("Meta Graph createCampaignDraft response missing id");
  });

  it("rejects blank external account ids before live Graph calls", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "238_campaign_live" }),
    });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.createCampaignDraft({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: " ",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    })).rejects.toThrow("externalAccountId is required");
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("creates live Meta ad sets through Graph", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "238_adset_live" }),
    });
    const adapter = createMetaAdapter({ graphFetch });

    const adset = await adapter.createAdSet({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
      audienceRef: JSON.stringify({ geo_locations: { countries: ["US"] } }),
    });

    expect(graphFetch).toHaveBeenCalledWith(
      expect.stringContaining("/act_123/adsets"),
      expect.objectContaining({ method: "POST" }),
    );
    const body = graphFetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("campaign_id")).toBe("camp_1");
    expect(body.get("daily_budget")).toBe("2500");
    expect(body.get("targeting")).toContain("geo_locations");
    expect(adset.externalAdSetId).toBe("238_adset_live");
  });

  it("creates live Meta ad creatives through Graph", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "238_creative_live" }),
    });
    const adapter = createMetaAdapter({ graphFetch });

    const creative = await adapter.createCreative({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      headline: "Ship faster",
      primaryText: "Let Trent do the follow-through.",
      cta: "Learn More",
      assetUrl: "https://example.com/ad.png",
    });

    expect(graphFetch).toHaveBeenCalledWith(
      expect.stringContaining("/act_123/adcreatives"),
      expect.objectContaining({ method: "POST" }),
    );
    const body = graphFetch.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("name")).toBe("Ship faster");
    expect(body.get("object_story_spec")).toContain("Let Trent do the follow-through.");
    expect(creative.externalCreativeId).toBe("238_creative_live");
  });

  it("fetches live Meta insights and maps spend/actions into normalized metrics", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          impressions: "1000",
          clicks: "44",
          spend: "12.34",
          actions: [{ action_type: "lead", value: "3" }],
        }],
      }),
    });
    const adapter = createMetaAdapter({ graphFetch });

    const insights = await adapter.fetchInsights({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
    });

    expect(graphFetch).toHaveBeenCalledWith(expect.stringContaining("/camp_1/insights"), expect.objectContaining({ method: "GET" }));
    expect(insights).toEqual({ platform: "meta", impressions: 1000, clicks: 44, spendCents: 1234, conversions: 3 });
  });

  it.each([
    ["ensureConversionSource", () => ({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Lead Pixel",
    })],
    ["sendConversionEvent", () => ({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      eventId: "evt_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T00:00:00Z",
    })],
  ])("throws a typed unsupported error for live %s until Graph support exists", async (methodName, inputFactory) => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn();
    const adapter = createMetaAdapter({ graphFetch });
    const method = adapter[methodName as keyof typeof adapter] as (input: unknown) => Promise<unknown>;

    await expect(method(inputFactory())).rejects.toBeInstanceOf(MetaLiveOperationUnsupportedError);
    await expect(method(inputFactory())).rejects.toThrow(`${methodName} is not implemented for live Meta Graph mode`);
    expect(graphFetch).not.toHaveBeenCalled();
  });

  it("pauses campaigns and updates budgets through live Meta Graph", async () => {
    mockResolveCredentialEnv.mockResolvedValue({
      META_ACCESS_TOKEN: "meta_live_secret_token_12345",
    });
    const graphFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const adapter = createMetaAdapter({ graphFetch });

    await expect(adapter.pauseCampaign({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
    })).resolves.toEqual({ platform: "meta", externalCampaignId: "camp_1", status: "paused" });
    await expect(adapter.setBudget({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      externalCampaignId: "camp_1",
      dailyBudgetCents: 3000,
    })).resolves.toEqual({ platform: "meta", externalCampaignId: "camp_1", status: "budget_updated" });

    expect(graphFetch).toHaveBeenCalledWith(expect.stringContaining("/camp_1"), expect.objectContaining({ method: "POST" }));
    const budgetBody = graphFetch.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(budgetBody.get("daily_budget")).toBe("3000");
  });
});
