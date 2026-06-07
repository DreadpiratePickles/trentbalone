import { checkModeration, type ModerationResult } from "@/lib/generation/moderation-filter";
import { generateImage, type ImageGenerationResult } from "@/lib/generation/image-router";
import { generateText, type TextGenerationResult } from "@/lib/generation/text-router";
import { store } from "@/lib/store";
import { evaluateBrandSafety, type BrandSafetyConstraints, type BrandSafetyResult } from "./brand-safety";
import { getMarketingPlatformAdapter, type MarketingPlatformAdapter } from "./platform-adapter";
import type { AdCampaign, AdCreativeVariant, AdCreativeVariantInput, MarketingAccount } from "./types";

export type CreativeVariantPipelineInput = {
  companyId: string;
  campaign: AdCampaign;
  marketingAccount: MarketingAccount;
  variantCount?: number;
  offer: string;
  audience: string;
  angle: string;
  constraints?: BrandSafetyConstraints;
};

export type CreativeVariantPipelineDeps = {
  generateText: (request: Parameters<typeof generateText>[0]) => Promise<TextGenerationResult>;
  generateImage: (request: Parameters<typeof generateImage>[0]) => Promise<ImageGenerationResult>;
  moderate: typeof checkModeration;
  store: {
    createAdCreativeVariant(input: AdCreativeVariantInput): Promise<AdCreativeVariant>;
  };
  platform: Pick<MarketingPlatformAdapter, "createCreative">;
};

export type CreativeVariantPipelineResult = {
  variants: AdCreativeVariant[];
};

type CreativeCopy = {
  headline: string;
  primaryText: string;
  cta: string;
  imagePrompt: string;
};

export async function generateCreativeVariants(
  input: CreativeVariantPipelineInput,
  deps = defaultDeps(input)
): Promise<CreativeVariantPipelineResult> {
  const count = normalizeVariantCount(input.variantCount);
  const variants: AdCreativeVariant[] = [];

  for (let index = 1; index <= count; index += 1) {
    const variantKey = `v${index}`;
    const sourcePrompt = buildSourcePrompt(input, index);
    const textResult = await deps.generateText({
      companyId: input.companyId,
      qualityTier: "draft",
      prompt: sourcePrompt,
      systemPrompt: creativeSystemPrompt,
      maxTokens: 500,
      description: `Generate ad creative variant ${index} for ${input.campaign.name}`,
    });
    const copy = parseCreativeCopy(textResult.text);
    const moderation = deps.moderate(
      [copy.headline, copy.primaryText, copy.cta, copy.imagePrompt].join("\n"),
      "text"
    );
    const brandSafety = evaluateBrandSafety({
      headline: copy.headline,
      primaryText: copy.primaryText,
      cta: copy.cta,
      moderation,
      constraints: input.constraints,
    });

    let assetUrl: string | undefined;
    let imageResult: ImageGenerationResult | undefined;
    let externalCreativeId: string | undefined;

    if (brandSafety.status === "approved") {
      imageResult = await deps.generateImage({
        companyId: input.companyId,
        qualityTier: "draft",
        prompt: copy.imagePrompt,
        description: `Generate ad creative asset ${index} for ${input.campaign.name}`,
      });
      assetUrl = imageResult.r2Url;

      const platformCreative = await deps.platform.createCreative({
        companyId: input.companyId,
        marketingAccountId: input.marketingAccount.id,
        externalAccountId: input.marketingAccount.externalAccountId,
        headline: copy.headline,
        primaryText: copy.primaryText,
        cta: copy.cta,
        assetUrl,
      });
      externalCreativeId = platformCreative.externalCreativeId;
    }

    variants.push(await deps.store.createAdCreativeVariant({
      companyId: input.companyId,
      campaignId: input.campaign.id,
      variantKey,
      headline: copy.headline,
      primaryText: copy.primaryText,
      cta: copy.cta,
      assetUrl,
      moderationStatus: moderation.verdict === "pass" ? "approved" : "rejected",
      brandSafetyStatus: brandSafety.status,
      externalCreativeId,
      metrics: buildVariantMetrics({
        input,
        sourcePrompt,
        textResult,
        imageResult,
        moderation,
        brandSafety,
      }),
    }));
  }

  return { variants };
}

function defaultDeps(input: CreativeVariantPipelineInput): CreativeVariantPipelineDeps {
  return {
    generateText,
    generateImage,
    moderate: checkModeration,
    store,
    platform: getMarketingPlatformAdapter(input.campaign.platform),
  };
}

function normalizeVariantCount(value: number | undefined) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return 5;
  return Math.min(value, 10);
}

function buildSourcePrompt(input: CreativeVariantPipelineInput, index: number) {
  return [
    `Create paid social ad creative variant ${index} for campaign "${input.campaign.name}".`,
    `Offer: ${input.offer}`,
    `Audience: ${input.audience}`,
    `Angle: ${input.angle}`,
    "Return exactly these fields: Headline, Primary Text, CTA, Image Prompt.",
    "Keep claims factual and avoid guarantees.",
  ].join("\n");
}

const creativeSystemPrompt = [
  "You write concise paid social ad creative.",
  "Return four labeled lines only: Headline, Primary Text, CTA, Image Prompt.",
].join(" ");

function parseCreativeCopy(text: string): CreativeCopy {
  const json = parseJsonCopy(text);
  if (json) return json;

  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(headline|primary\s*text|cta|image\s*prompt)\s*:\s*(.+)\s*$/i);
    if (match) fields.set(normalizeField(match[1] ?? ""), (match[2] ?? "").trim());
  }

  return {
    headline: fields.get("headline") ?? firstNonEmptyLine(text) ?? "Launch faster with Trent",
    primaryText: fields.get("primaryText") ?? "Turn founder intent into shipped work with Trent.",
    cta: fields.get("cta") ?? "Learn more",
    imagePrompt: fields.get("imagePrompt") ?? "clean product screenshot of an operating dashboard",
  };
}

function parseJsonCopy(text: string): CreativeCopy | null {
  try {
    const parsed = JSON.parse(text) as Partial<Record<keyof CreativeCopy, unknown>>;
    const headline = stringValue(parsed.headline);
    const primaryText = stringValue(parsed.primaryText);
    const cta = stringValue(parsed.cta);
    const imagePrompt = stringValue(parsed.imagePrompt);
    if (headline && primaryText && cta && imagePrompt) {
      return { headline, primaryText, cta, imagePrompt };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeField(value: string) {
  return value.toLowerCase().replace(/\s+/g, "") === "primarytext"
    ? "primaryText"
    : value.toLowerCase().replace(/\s+/g, "") === "imageprompt"
      ? "imagePrompt"
      : value.toLowerCase();
}

function firstNonEmptyLine(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildVariantMetrics(input: {
  input: CreativeVariantPipelineInput;
  sourcePrompt: string;
  textResult: TextGenerationResult;
  imageResult?: ImageGenerationResult;
  moderation: ModerationResult;
  brandSafety: BrandSafetyResult;
}) {
  return {
    sourcePrompt: input.sourcePrompt,
    offer: input.input.offer,
    audience: input.input.audience,
    angle: input.input.angle,
    text: {
      provider: input.textResult.provider,
      model: input.textResult.model,
      fingerprint: input.textResult.fingerprint,
      actualCostCents: input.textResult.actualCostCents,
    },
    image: input.imageResult ? {
      provider: input.imageResult.provider,
      model: input.imageResult.model,
      fingerprint: input.imageResult.fingerprint,
      actualCostCents: input.imageResult.actualCostCents,
    } : null,
    moderation: input.moderation,
    brandSafetyReasons: input.brandSafety.reasons,
  };
}
