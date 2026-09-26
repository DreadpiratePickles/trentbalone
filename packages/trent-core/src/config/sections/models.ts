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

// [L1] small models
/**
 * Three more `models.local` keys, spread into that block below, and `models.escalate`.
 * `reasoning_effort`: what a seat or the consolidator on a local runtime sends; absent is `none`
 * (thinking off: 1,267 thinking tokens at 3 tok/s on one qwen3.5:9b seat step, L0-2's live run). The
 * planner and the critic keep `models.reasoning_effort`. `constrained_output`: seat turns decoded under a
 * JSON schema; absent is true (local runtimes), `all` adds hosted providers, false turns it off.
 * `job_timeout_seconds`: the app's per-job timeout for a local run; absent is 1800 (the app's own is 600).
 * `escalate`: a hosted model that only the named roles may use, each call held for the owner's approval
 * with a preview of what would leave the machine (`model-gateway/escalation.ts`). Unset by default.
 * See docs/configuration.md, "Local models" and "Hosted escalation".
 */
const SMALL_MODEL_LOCAL_KEYS = {
  reasoning_effort: z.enum(["none", "minimal", "low", "medium", "high"]).optional(),
  constrained_output: z.union([z.boolean(), z.literal("all")]).optional(),
  job_timeout_seconds: z.number().int().positive().optional(),
};

export const EscalateConfigSchema = z.object({
  model: z.string().min(1).optional(),
  provider: ProviderSchema.optional(),
  on: z.array(z.enum(["planner", "critic", "step_failed"])).min(1),
}).strict();

export type EscalateConfig = z.infer<typeof EscalateConfigSchema>;
// [/L1]

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
  // [L0-2] local
  // `local`: budgets for a model on this machine (provider `ollama` or `lmstudio`); each absent key
  // keeps the gateway's default (`model-gateway/local-runtime.ts`): 300 s to the first token, 120 s
  // of silence after it, a 32768-token window when the server cannot be asked, and 1 call in flight
  // on Ollama (its OLLAMA_NUM_PARALLEL default) or 4 on LM Studio. See docs/configuration.md, "Local models".
  local: z.object({
    ttft_seconds: z.number().int().positive().optional(),
    idle_seconds: z.number().int().positive().optional(),
    context_tokens: z.number().int().positive().optional(),
    max_in_flight: z.number().int().positive().optional(),
    ...SMALL_MODEL_LOCAL_KEYS, // [L1]
  }).strict().optional(),
  // [/L0-2]
  escalate: EscalateConfigSchema.optional(), // [L1]
}).strict();
