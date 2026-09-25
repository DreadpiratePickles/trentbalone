/**
 * Local type declarations for the @trent/core model gateway wrapper.
 *
 * These are REDECLARED here on purpose. Re-exporting from `@/lib/types` or
 * `@/lib/planner` drags the whole (Prisma-tainted) web type graph into
 * `tsc -p packages/trent-core/tsconfig.json`.
 * See 01_discovery/output/model-gateway-contract.md, "Other notes".
 */

import type { ReasoningEffort } from "./call-policy.js";

/**
 * The five provider identities `apps/web` understands. This union does NOT grow when Trent gains a
 * new endpoint: `ollama`, `lmstudio`, `deepseek` and `groq` are OpenAI-compatible, so they are
 * resolved at the boundary (`providers.ts`) into one of these plus a base URL. Adding them here
 * would mean teaching a read-only app, its doctor probes and its tier tables about identities they
 * can never route.
 */
export type ModelProvider = "anthropic" | "openai" | "google" | "mistral" | "openrouter";
export type ModelTier = "haiku" | "sonnet" | "opus";
export type StreamRole = "executor" | "planner";

export type GatewayMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GatewayStreamRequest = {
  messages: GatewayMessage[];
  role?: StreamRole;
  /** Force a single provider, bypassing the fallback chain. */
  provider?: ModelProvider;
  /**
   * [P1-C] An EXPLICIT model for this request: a seat pin, a `--model` flag, a cron pin. Absent is
   * DEFAULT-RESOLVED (the route's configured model, with the fallback chain). An explicit model is
   * answered by that model or the call fails with its provider's own error, unless
   * `models.fallback_on_pin` is true (`call-policy.ts`).
   */
  model?: string;
  /** [P1-C] Beats `models.reasoning_effort` for this call. Sent to Google only (`openai-compat.ts`). */
  reasoningEffort?: ReasoningEffort;
  maxTokens?: number;
  temperature?: number;
  /**
   * Cancellation. There is no AbortSignal support upstream, so the wrapper
   * implements it by breaking the `for await` loop, which calls the upstream
   * generator's `return()` and closes the reader.
   */
  signal?: AbortSignal;
};

export type GatewayFinishReason = "stop" | "length" | "aborted" | "error" | string;

export type GatewayStreamEvent =
  | { type: "token"; content: string; provider: ModelProvider; model: string }
  | {
      type: "usage";
      provider: ModelProvider;
      model: string;
      modelTier: ModelTier;
      inputTokens: number;
      outputTokens: number;
      /**
       * [P1-C] The part of `inputTokens` the provider served from its prompt cache, priced at the
       * row's cached ratio (`pricing.ts`). 0 when the provider reported none; the gateway always sets it.
       */
      cachedInputTokens?: number;
      /** [P1-C] Thinking tokens inside `outputTokens`, when the provider reports them. */
      reasoningTokens?: number;
      /** Always INTEGER CENTS. Never a float. */
      costCents: number;
      /**
       * True when the provider emitted no usage frame and these numbers were
       * estimated locally (google / mistral / openrouter commonly emit none —
       * `stream_options.include_usage` is set only for openai upstream).
       */
      estimated: boolean;
      /**
       * True when the model id has no row in the wrapper's price table (`pricing.ts`) and the
       * app's tier price (Anthropic list for haiku/sonnet/opus) priced the call instead.
       */
      priced_as_default: boolean;
      /**
       * True when NOTHING priced this model: no table row, no prefix rule, no `model_overrides`
       * entry. `costCents` is then the app's tier estimate and must not be read as a bill. The
       * flag exists so an unpriced model is visible on the meter instead of quietly billing at
       * the Anthropic tier, which is wrong by up to 10x (audit A.6).
       */
      unpriced: boolean;
      /** The user-facing provider name when the call was routed through an alias (`ollama`, …). */
      providerAlias?: string;
    }
  | { type: "finish"; reason: GatewayFinishReason; provider: ModelProvider; model: string };

export type GatewayCompletion = {
  text: string;
  provider: ModelProvider;
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  /** [P1-C] See the usage event. Optional here only so existing fakes keep compiling. */
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costCents: number;
  estimated: boolean;
  priced_as_default: boolean;
  /** See the usage event. Optional here only so existing fakes keep compiling. */
  unpriced?: boolean;
  providerAlias?: string;
  finishReason: GatewayFinishReason;
};

export type GatewayRoute = {
  providers: ModelProvider[];
  fallbackChain: ModelProvider[];
  modelTier: ModelTier;
  explicitModel: string;
  modelForProvider: (provider: ModelProvider) => string;
};

/** Mirrors `ProviderStreamToken` in apps/web/lib/ai-client.ts:390-393. */
export type ProviderStreamFrame =
  | { type: "token"; content: string }
  | { type: "finish"; reason: string }
  | {
      type: "usage";
      inputTokens: number;
      /** Billed output, thinking tokens included. */
      outputTokens: number;
      /** [P1-C] Prompt-cache hits inside `inputTokens`; absent means none were reported. */
      cachedInputTokens?: number;
      /** [P1-C] Thinking tokens inside `outputTokens`. */
      reasoningTokens?: number;
    };

/**
 * Injection point used by the offline tests; the default hits the real providers.
 *
 * `signal` is forwarded so an implementation that CAN cancel its request does. The default
 * implementation calls `apps/web/lib/ai-client.ts`, whose two stream functions take no signal, so
 * for those the gateway stops consuming and calls the generator's `return()` instead — see the
 * cancellation note in `index.ts`.
 */
export type ProviderStreamFn = (
  provider: ModelProvider,
  model: string,
  input: { messages: GatewayMessage[]; temperature: number; maxTokens: number; signal?: AbortSignal; reasoningEffort?: ReasoningEffort },
) => AsyncGenerator<ProviderStreamFrame>;

export type ModelGatewayConfig = {
  /** Written into process.env BEFORE the web modules are imported (trap 1). */
  apiKeys?: Partial<Record<ModelProvider, string>>;
  /** Extra env vars seeded before the dynamic import. Values are never logged. */
  env?: Record<string, string>;
  preferredProvider?: ModelProvider;
  allowedProviders?: ModelProvider[];
  models?: { executor?: string; planner?: string };
  streamProvider?: ProviderStreamFn;
  /**
   * The `privacy` block of config. Omitted means "read the env bridge" (`TRENT_PRIVACY_*`), which
   * the headless runtime writes from config because the orchestrator builds its gateway with no
   * arguments. When `redact_prompts` is on, every message content is redacted before the provider
   * call (`redact.ts`); a bad `patterns[]` entry throws at construction, not on the first prompt.
   */
  privacy?: { redact_prompts: boolean; patterns: readonly string[] };
  /** Where the per-request redaction summary goes (hit counts only). Defaults to a stderr logger. */
  redactionLog?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * Bounded retry for one provider attempt. Omitted means `DEFAULT_RETRY_POLICY` (3 attempts,
   * 500 ms base, 8 s cap). `sleep` and `random` are test seams: they let a suite ASSERT a backoff
   * instead of waiting for it.
   */
  retry?: {
    attempts?: number;
    baseMs?: number;
    capMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
  };
  /** Where retry lines go (provider, status, attempt, delay — never a credential). */
  retryLog?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * `model_overrides` from config: a per-model price and context window that beats the shipped
   * table. Omitted means "read the env bridge" (`TRENT_MODEL_OVERRIDES`), because the orchestrator
   * builds its gateway with no arguments.
   */
  modelOverrides?: ModelOverrides;
  /**
   * [P1-C] `models.fallback_on_pin` and `models.reasoning_effort`. Omitted means "read the env
   * bridge" (`call-policy.ts`), because the orchestrator builds its gateway with no arguments.
   */
  fallbackOnPin?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** [P1-C] Test seam for the Trent-side Google streamer; the default is the global `fetch`. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
};

/** One `model_overrides` entry. Rates are CENTS per million tokens; the cost itself is integer cents. */
export interface ModelOverride {
  readonly context_window?: number;
  readonly input_cents_per_million?: number;
  readonly output_cents_per_million?: number;
}

export type ModelOverrides = Readonly<Record<string, ModelOverride>>;

export interface ModelGateway {
  stream(req: GatewayStreamRequest): AsyncGenerator<GatewayStreamEvent>;
  complete(req: GatewayStreamRequest): Promise<GatewayCompletion>;
  resolveRoute(role?: StreamRole): GatewayRoute;
  configuredProviders(): ModelProvider[];
  /** With `model`, the per-model overlay (`pricing.ts`) applies; without it, the app's tier price. */
  estimateCostCents(input: { modelTier: ModelTier; inputTokens: number; outputTokens: number; model?: string; cachedInputTokens?: number }): number;
}
