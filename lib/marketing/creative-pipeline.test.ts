import { describe, expect, it, vi } from "vitest";
import { generateCreativeVariants } from "./creative-pipeline";
import type { CreativeVariantPipelineDeps } from "./creative-pipeline";
import type { AdCampaign, AdCreativeVariantInput, MarketingAccount } from "./types";

const campaign: AdCampaign = {
  id: "camp_1",
  companyId: "co_1",
  marketingAccountId: "ma_1",
  platform: "meta",
  externalCampaignId: "ext_campaign_1",
  name: "Launch Alpha",
  objective: "LEADS",
  status: "draft",
  dailyBudgetCents: 2500,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:00.000Z",
};

const account: MarketingAccount = {
  id: "ma_1",
  companyId: "co_1",
  platform: "meta",
  status: "active",
  externalAccountId: "act_123",
  currency: "USD",
  paymentStatus: "ready",
  consentForServerEvents: true,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:00:00.000Z",
};

describe("generateCreativeVariants", () => {
  it("generates the default five variants and stores lineage for each", async () => {
    const deps = pipelineDeps();

    const result = await generateCreativeVariants({
      companyId: "co_1",
      campaign,
      marketingAccount: account,
      offer: "AI cofounder operating system",
      audience: "solo founders",
      angle: "ship weekly",
    }, deps);

    expect(result.variants).toHaveLength(5);
    expect(deps.generateText).toHaveBeenCalledTimes(5);
    expect(deps.generateImage).toHaveBeenCalledTimes(5);
    expect(deps.platform.createCreative).toHaveBeenCalledTimes(5);
    expect(deps.store.createAdCreativeVariant).toHaveBeenCalledTimes(5);
    expect(deps.store.createAdCreativeVariant).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "camp_1",
      headline: "Ship more by Friday",
      primaryText: "Trent turns founder intent into shipped work.",
      cta: "Book demo",
      assetUrl: "https://cdn.test/ad.png",
      moderationStatus: "approved",
      brandSafetyStatus: "approved",
      externalCreativeId: "creative_ext_1",
      metrics: expect.objectContaining({
        sourcePrompt: expect.stringContaining("solo founders"),
        offer: "AI cofounder operating system",
      }),
    }));
  });

  it("honors requested variant count and caps it at ten", async () => {
    const deps = pipelineDeps();

    const result = await generateCreativeVariants({
      companyId: "co_1",
      campaign,
      marketingAccount: account,
      variantCount: 12,
      offer: "AI cofounder operating system",
      audience: "solo founders",
      angle: "ship weekly",
    }, deps);

    expect(result.variants).toHaveLength(10);
    expect(deps.generateText).toHaveBeenCalledTimes(10);
  });

  it("uses injectable Phase 4 text and image routers without external providers in tests", async () => {
    const deps = pipelineDeps();

    await generateCreativeVariants({
      companyId: "co_1",
      campaign,
      marketingAccount: account,
      variantCount: 1,
      offer: "AI cofounder operating system",
      audience: "solo founders",
      angle: "ship weekly",
    }, deps);

    expect(deps.generateText).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      qualityTier: "draft",
      description: "Generate ad creative variant 1 for Launch Alpha",
    }));
    expect(deps.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      qualityTier: "draft",
      prompt: expect.stringContaining("clean product screenshot"),
    }));
  });

  it("stores rejected lineage and prevents platform creative creation when moderation blocks", async () => {
    const deps = pipelineDeps({
      moderation: () => ({
        verdict: "block",
        category: "violence",
        reason: "Explicit violence or instructions for harm detected.",
      }),
    });

    const result = await generateCreativeVariants({
      companyId: "co_1",
      campaign,
      marketingAccount: account,
      variantCount: 1,
      offer: "AI cofounder operating system",
      audience: "solo founders",
      angle: "ship weekly",
    }, deps);

    expect(result.variants[0]?.moderationStatus).toBe("rejected");
    expect(result.variants[0]?.brandSafetyStatus).toBe("rejected");
    expect(deps.platform.createCreative).not.toHaveBeenCalled();
    expect(deps.store.createAdCreativeVariant).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: "camp_1",
      externalCreativeId: undefined,
      metrics: expect.objectContaining({
        moderation: expect.objectContaining({ verdict: "block", category: "violence" }),
        brandSafetyReasons: ["moderation_block:violence"],
      }),
    }));
  });

  it("prevents platform creative creation when brand safety rejects generated claims", async () => {
    const deps = pipelineDeps({
      text: "Headline: Guaranteed ROAS\nPrimary Text: Trent guarantees revenue growth.\nCTA: Start now\nImage Prompt: bold SaaS dashboard",
    });

    const result = await generateCreativeVariants({
      companyId: "co_1",
      campaign,
      marketingAccount: account,
      variantCount: 1,
      offer: "AI cofounder operating system",
      audience: "solo founders",
      angle: "ship weekly",
    }, deps);

    expect(result.variants[0]?.brandSafetyStatus).toBe("rejected");
    expect(deps.platform.createCreative).not.toHaveBeenCalled();
  });
});

function pipelineDeps(overrides: {
  text?: string;
  moderation?: CreativeVariantPipelineDeps["moderate"];
} = {}) {
  const createAdCreativeVariant = vi.fn(async (input: AdCreativeVariantInput) => ({
    id: `variant_${input.variantKey}`,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...input,
  }));

  return {
    generateText: vi.fn(async () => ({
      text: overrides.text ??
        "Headline: Ship more by Friday\nPrimary Text: Trent turns founder intent into shipped work.\nCTA: Book demo\nImage Prompt: clean product screenshot with weekly planning board",
      provider: "test",
      model: "test-text",
      qualityTier: "draft" as const,
      actualCostCents: 0,
      fingerprint: "fp_text",
      tokensUsed: { input: 10, output: 20 },
    })),
    generateImage: vi.fn(async () => ({
      r2Url: "https://cdn.test/ad.png",
      provider: "test",
      model: "test-image",
      qualityTier: "draft" as const,
      actualCostCents: 0,
      fingerprint: "fp_image",
      format: "png" as const,
    })),
    moderate: overrides.moderation ?? vi.fn(() => ({ verdict: "pass" as const })),
    store: { createAdCreativeVariant },
    platform: {
      createCreative: vi.fn(async () => ({
        platform: "meta" as const,
        externalCreativeId: "creative_ext_1",
        status: "draft" as const,
      })),
    },
  };
}
