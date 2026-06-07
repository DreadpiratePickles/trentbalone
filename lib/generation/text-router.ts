/**
 * lib/generation/text-router.ts
 *
 * Multi-provider text generation with fallback chain, budget enforcement,
 * brand voice injection, fingerprinting, and ledger integration.
 *
 * Key invariants:
 *  - selectModel() fires before any provider API call — budget gates all generation.
 *  - Text returned inline (NOT stored to R2). R2 is for binary media assets.
 *  - Fallback stays within the requested quality tier — no silent downgrade.
 *  - Fingerprint computed from inputs only — output does not affect it.
 *  - Every successful generation writes a "media" ledger entry with actual cost.
 *  - Empty provider responses are treated as failures and trigger the next fallback.
 *  - API keys come from process.env only — never from model context or logs.
 *
 * Provider routing:
 *  Anthropic/Claude models are called via OpenRouter (OpenAI-compatible).
 *  OpenAI models are called directly. No additional SDK dependency required.
 */

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { selectModel, getEstimatedCost } from "@/lib/generation/cost-optimizer";
import type { QualityTier } from "@/lib/generation/cost-optimizer";
import { checkModeration, ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { store } from "@/lib/store";

// ── Provider interface ────────────────────────────────────────────────────────

export interface TextProvider {
  readonly provider: string;
  readonly model: string;
  generate(req: TextProviderRequest): Promise<TextProviderResponse>;
}

export type TextProviderRequest = {
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
};

export type TextProviderResponse = {
  text: string;
  tokensUsed: { input: number; output: number };
};

// ── Public types ──────────────────────────────────────────────────────────────

export type TextGenerationRequest = {
  companyId: string;
  qualityTier: QualityTier;
  prompt: string;
  systemPrompt?: string;
  /** Injected by voice-memory.ts (Phase 4 build item 5). Prepended to system prompt. */
  brandVoiceContext?: string;
  maxTokens?: number;
  /** 1K-token units. Defaults to rough estimate from prompt length. */
  estimatedUnits?: number;
  description: string;
};

export type TextGenerationResult = {
  text: string;
  provider: string;
  model: string;
  qualityTier: QualityTier;
  actualCostCents: number;
  /** SHA-256 of generation inputs. For fingerprint-cache.ts lookup (Phase 4 build item 7). */
  fingerprint: string;
  tokensUsed: { input: number; output: number };
};

export type TextRouterOptions = {
  /** Override the provider chain. Used in tests and for per-company API key injection. */
  providers?: TextProvider[];
};

// ── Error types ───────────────────────────────────────────────────────────────

export class AllProvidersFailedError extends Error {
  constructor(
    readonly qualityTier: QualityTier,
    readonly attempts: Array<{ provider: string; model: string; error: string }>
  ) {
    const summary = attempts.map(a => `${a.provider}/${a.model}: ${a.error}`).join("; ");
    super(`All text providers failed for ${qualityTier} quality. Attempts: [${summary}]`);
    this.name = "AllProvidersFailedError";
  }
}

// ── Fallback chain ────────────────────────────────────────────────────────────

type ProviderConfig = { provider: string; model: string; client: "openai" | "openrouter" };

const TEXT_FALLBACK_CHAIN: Record<QualityTier, ProviderConfig[]> = {
  draft: [
    { provider: "anthropic",  model: "anthropic/claude-haiku-4-5",       client: "openrouter" },
    { provider: "openai",     model: "gpt-4o-mini",                       client: "openai"     },
    { provider: "openrouter", model: "mistralai/mistral-7b-instruct",     client: "openrouter" },
  ],
  standard: [
    { provider: "anthropic",  model: "anthropic/claude-sonnet-4-6",       client: "openrouter" },
    { provider: "openai",     model: "gpt-4o",                            client: "openai"     },
    { provider: "openrouter", model: "google/gemini-flash-1.5",           client: "openrouter" },
  ],
  premium: [
    { provider: "anthropic",  model: "anthropic/claude-opus-4-8",         client: "openrouter" },
    { provider: "openai",     model: "gpt-4o",                            client: "openai"     },
    { provider: "openrouter", model: "google/gemini-pro-1.5",             client: "openrouter" },
  ],
};

// ── Real provider implementations ─────────────────────────────────────────────

class OpenAITextProvider implements TextProvider {
  readonly provider = "openai";
  readonly model: string;
  private client: OpenAI;

  constructor(model: string) {
    this.model = model;
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      timeout: 30_000,
    });
  }

  async generate(req: TextProviderRequest): Promise<TextProviderResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user",   content: req.prompt },
      ],
    });
    return {
      text: completion.choices[0]?.message?.content ?? "",
      tokensUsed: {
        input:  completion.usage?.prompt_tokens     ?? 0,
        output: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

class OpenRouterTextProvider implements TextProvider {
  readonly provider: string;
  readonly model: string;
  private client: OpenAI;

  constructor(provider: string, model: string) {
    this.provider = provider;
    this.model    = model;
    this.client   = new OpenAI({
      apiKey:  process.env.OPENROUTER_API_KEY ?? "",
      baseURL: "https://openrouter.ai/api/v1",
      timeout: 30_000,
      defaultHeaders: {
        "HTTP-Referer": "https://trent.app",
        "X-Title":      "Trent",
      },
    });
  }

  async generate(req: TextProviderRequest): Promise<TextProviderResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user",   content: req.prompt },
      ],
    });
    return {
      text: completion.choices[0]?.message?.content ?? "",
      tokensUsed: {
        input:  completion.usage?.prompt_tokens     ?? 0,
        output: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function createDefaultProviders(qualityTier: QualityTier): TextProvider[] {
  return TEXT_FALLBACK_CHAIN[qualityTier].map(cfg =>
    cfg.client === "openai"
      ? new OpenAITextProvider(cfg.model)
      : new OpenRouterTextProvider(cfg.provider, cfg.model)
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeFingerprint(
  prompt: string,
  systemPrompt: string,
  brandVoiceContext: string | undefined,
  model: string
): string {
  const data = JSON.stringify({
    prompt,
    systemPrompt,
    brandVoiceContext: brandVoiceContext ?? null,
    model,
  });
  return createHash("sha256").update(data).digest("hex");
}

// ── generateText ──────────────────────────────────────────────────────────────

export async function generateText(
  req: TextGenerationRequest,
  options?: TextRouterOptions
): Promise<TextGenerationResult> {
  const maxTokens      = req.maxTokens ?? 4096;
  const estimatedUnits = req.estimatedUnits ?? Math.max(1, Math.ceil(req.prompt.length / 4 / 1000));

  // 1. Moderation check — blocked prompts must never reach a generation provider.
  const modResult = checkModeration(
    [req.systemPrompt, req.brandVoiceContext, req.prompt].filter(Boolean).join("\n"),
    "text"
  );
  if (modResult.verdict === "block") {
    throw new ModerationBlockedError(modResult);
  }

  // 2. Budget check + model selection (throws SpendCapExceededError / BudgetQualityConflictError)
  const selection = await selectModel({
    companyId:      req.companyId,
    taskType:       "text",
    qualityTier:    req.qualityTier,
    estimatedUnits,
    description:    req.description,
  });

  // 3. Build system prompt, optionally appending brand voice context
  const systemParts: string[] = [
    req.systemPrompt ?? "You are a helpful AI assistant producing high-quality content.",
  ];
  if (req.brandVoiceContext) {
    systemParts.push(`\nBrand voice guidance:\n${req.brandVoiceContext}`);
  }
  const systemPrompt = systemParts.join("");

  // 4. Input fingerprint — computed before generation, independent of output
  const fingerprint = computeFingerprint(
    req.prompt,
    systemPrompt,
    req.brandVoiceContext,
    selection.model,
  );

  // 5. Try each provider in order; skip on failure or empty response
  const providers = options?.providers ?? createDefaultProviders(req.qualityTier);
  const attempts: Array<{ provider: string; model: string; error: string }> = [];

  for (const p of providers) {
    try {
      const response = await p.generate({ systemPrompt, prompt: req.prompt, maxTokens });

      if (!response.text) {
        attempts.push({ provider: p.provider, model: p.model, error: "empty response" });
        continue;
      }

      // 6. Write actual cost to "media" ledger entry.
      // amountCents is Int in Prisma — round the float to the nearest integer cent.
      // Sub-cent text generations (< 0.5¢) store and return 0, which is correct
      // for billing purposes (essentially free at this volume).
      const totalTokens     = response.tokensUsed.input + response.tokensUsed.output;
      const actualCostCents = Math.round(getEstimatedCost("text", req.qualityTier, totalTokens / 1000));

      await store.addUsage({
        companyId:   req.companyId,
        category:    "media",
        description: req.description,
        amountCents: actualCostCents,
        metadata: {
          provider:     p.provider,
          model:        p.model,
          qualityTier:  req.qualityTier,
          fingerprint,
          tokensInput:  response.tokensUsed.input,
          tokensOutput: response.tokensUsed.output,
        },
      });

      return {
        text:            response.text,
        provider:        p.provider,
        model:           p.model,
        qualityTier:     req.qualityTier,
        actualCostCents,
        fingerprint,
        tokensUsed:      response.tokensUsed,
      };
    } catch (err) {
      attempts.push({
        provider: p.provider,
        model:    p.model,
        error:    err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new AllProvidersFailedError(req.qualityTier, attempts);
}
