import { beforeEach, describe, expect, it } from "vitest";
import { upsertMarketingAccountForCompany, normalizeMarketingPlatform } from "./accounts";
import { memStore } from "@/lib/mem-store";
import type { AdCampaignInput, AdCreativeVariantInput, ConversionEventInput } from "./types";

describe("marketing account helpers", () => {
  beforeEach(() => {
    globalThis.__trentState = undefined;
  });

  it("normalizes supported marketing platforms and rejects unknown values", () => {
    expect(normalizeMarketingPlatform("Meta")).toBe("meta");
    expect(normalizeMarketingPlatform(" google ")).toBe("google");
    expect(normalizeMarketingPlatform("TikTok")).toBe("tiktok");
    expect(normalizeMarketingPlatform("LinkedIn")).toBe("linkedin");
    expect(normalizeMarketingPlatform("Reddit")).toBe("reddit");
    expect(() => normalizeMarketingPlatform("snapchat")).toThrow(/Unsupported marketing platform/i);
  });

  it("updates the existing row for a duplicate company and platform", async () => {
    const first = await upsertMarketingAccountForCompany(memStore, {
      companyId: "company_trent_demo",
      platform: "Meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "usd",
      dailyBudgetCents: 2500,
      consentForServerEvents: false,
    });

    const second = await upsertMarketingAccountForCompany(memStore, {
      companyId: "company_trent_demo",
      platform: "meta",
      externalAccountId: "act_2",
      externalBusinessId: "biz_2",
      currency: "cad",
      dailyBudgetCents: 5000,
      consentForServerEvents: true,
    });

    expect(second.id).toBe(first.id);
    expect(second.externalAccountId).toBe("act_2");
    expect(second.externalBusinessId).toBe("biz_2");
    expect(second.currency).toBe("CAD");
    expect(second.dailyBudgetCents).toBe(5000);
    expect(second.consentForServerEvents).toBe(true);

    await expect(memStore.listMarketingAccounts("company_trent_demo")).resolves.toHaveLength(1);
  });

  it("preserves omitted optional fields when updating an existing account", async () => {
    const first = await memStore.upsertMarketingAccount({
      companyId: "company_trent_demo",
      platform: "meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "CAD",
      dailyBudgetCents: 5000,
      consentForServerEvents: true,
      status: "paused",
      paymentStatus: "blocked",
    });

    const second = await memStore.upsertMarketingAccount({
      companyId: "company_trent_demo",
      platform: "meta",
      externalAccountId: "act_2",
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      externalAccountId: "act_2",
      externalBusinessId: "biz_1",
      currency: "CAD",
      dailyBudgetCents: 5000,
      consentForServerEvents: true,
      status: "paused",
      paymentStatus: "blocked",
    });
  });

  it("creates and retrieves conversion events by unique eventId", async () => {
    const input: ConversionEventInput = {
      companyId: "company_trent_demo",
      eventId: "evt_unique_1",
      eventName: "Lead",
      occurredAt: "2026-05-29T12:00:00.000Z",
      sourceUrl: "https://example.com",
      userAgentHash: "hash_1",
      fbp: "fbp_1",
      fbc: "fbc_1",
      hashedUserData: { em: "hash" },
      deliveryStatus: "pending",
      diagnostics: {},
    };

    const event = await memStore.createConversionEvent(input);

    expect(event.id).toMatch(/^conversion_/);
    await expect(memStore.getConversionEventByEventId("evt_unique_1")).resolves.toMatchObject({
      id: event.id,
      eventName: "Lead",
      sourceUrl: "https://example.com",
    });
    await expect(memStore.createConversionEvent(input)).rejects.toThrow(/eventId/i);
  });

  it("creates and updates ad campaigns through the store", async () => {
    const input: AdCampaignInput = {
      companyId: "company_trent_demo",
      marketingAccountId: "mktacct_1",
      platform: "meta",
      externalCampaignId: undefined,
      name: "Lead magnet campaign",
      objective: "LEADS",
      status: "draft",
      dailyBudgetCents: 2500,
      approvalId: undefined,
    };

    const campaign = await memStore.createAdCampaign(input);
    const updated = await memStore.updateAdCampaign(campaign.id, {
      status: "paused",
      externalCampaignId: "cmp_1",
      dailyBudgetCents: 4000,
    });

    expect(updated).toMatchObject({
      id: campaign.id,
      status: "paused",
      externalCampaignId: "cmp_1",
      dailyBudgetCents: 4000,
    });
  });

  it("creates and updates creative variants through the store", async () => {
    const input: AdCreativeVariantInput = {
      companyId: "company_trent_demo",
      campaignId: "campaign_1",
      variantKey: "headline-a",
      headline: "Ship faster",
      primaryText: "Let Trent handle the weekly operating loop.",
      cta: "Learn More",
      assetUrl: "https://example.com/asset.png",
      moderationStatus: "pending",
      brandSafetyStatus: "pending",
      externalCreativeId: undefined,
      metrics: {},
    };

    const variant = await memStore.createAdCreativeVariant(input);
    const updated = await memStore.updateAdCreativeVariant(variant.id, {
      moderationStatus: "approved",
      brandSafetyStatus: "approved",
      externalCreativeId: "creative_1",
      metrics: { impressions: 100 },
    });

    expect(updated).toMatchObject({
      id: variant.id,
      moderationStatus: "approved",
      brandSafetyStatus: "approved",
      externalCreativeId: "creative_1",
      metrics: { impressions: 100 },
    });
  });
});
