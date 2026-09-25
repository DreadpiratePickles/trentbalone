/**
 * `provider`, `model_overrides` and the `models` tier block of `TrentConfigSchema`.
 * Composed in `config/schema.ts`, which re-exports every name here.
 */

import { z } from "zod";

/**
 * The five provider identities `apps/web` routes natively, then the four OpenAI-compatible
 * endpoints the gateway resolves at the boundary (`model-gateway/providers.ts`) into `openai`
 * plus a base URL. Every name here must be routable: `providers-schema.test.ts` fails if one is
 * accepted by this enum and reaches no model.
 */
export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "deepseek",
  "groq",
  "ollama",
  "lmstudio",
]);

export type Provider = z.infer<typeof ProviderSchema>;

/**
 * A per-model price and context window that beats the gateway's shipped table
 * (`model-gateway/pricing.ts`). Rates are CENTS per million tokens — the computed cost is still
 * integer cents — so a $3.00/1M list price is written as 300.
 */
export const ModelOverrideSchema = z.object({
  context_window: z.number().int().positive().optional(),
  input_cents_per_million: z.number().nonnegative().optional(),
  output_cents_per_million: z.number().nonnegative().optional(),
}).strict();

export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

// [B2.1] model tiers
/**
 * `models`: one model id per tier. `orchestrator/model-env.ts` maps these onto the per-provider
 * `*_MODEL_FAST` / `*_MODEL_DEFAULT` / `*_MODEL_STRONG` variables the app's resolver reads, so a
 * seat's manifest tier (`SEAT_MANIFESTS[role].modelTier`) chooses a different model instead of
 * every seat running the one `model` above. `fast` is the haiku tier, `executor` the sonnet tier
 * and `planner` the opus tier; `judge` names the critic's model where a provider has a critic
 * variable of its own (`OPENAI_MODEL_CRITIC`) — the self-improvement loop's judge is a separate
 * key, `improve.judge_model`. A tier nothing names falls back to `executor`, and `executor`
 * itself to `model`, so an untiered profile behaves exactly as it did before this key existed.
 * An operator's own environment variable still wins. See docs/configuration.md, "Model tiers".
 */
export const ModelTiersConfigSchema = z.object({
  fast: z.string().min(1).optional(),
  executor: z.string().min(1).optional(),
  planner: z.string().min(1).optional(),
  judge: z.string().min(1).optional(),
  // [P1-C] model cost
  // `fallback_on_pin`: absent is false. A request that names its model (a pin) is answered by that
  // model or fails with its provider's own error; true lets it fall back across the provider chain
  // like a default-resolved request (`model-gateway/call-policy.ts`).
  // `reasoning_effort`: absent is omitted from the request body, so Google uses the model's default.
  // The values are Google's (https://ai.google.dev/gemini-api/docs/openai, "Thinking"); `none` is
  // accepted for 2.5 models only. Listed literally, as `media.ts` does for the alias table, so config
  // does not import the gateway; `model-gateway/call-policy.test.ts` asserts the two lists agree.
  fallback_on_pin: z.boolean().optional(),
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
  // [/P1-C]
}).strict();
