/**
 * Local type declarations for the @trent/core model gateway wrapper.
 *
 * These are REDECLARED here on purpose. Re-exporting from `@/lib/types` or
 * `@/lib/planner` drags the whole (Prisma-tainted) web type graph into
 * `tsc -p packages/trent-core/tsconfig.json`.
 * See 01_discovery/output/model-gateway-contract.md, "Other notes".
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
      /** Always INTEGER CENTS. Never a float. */
      costCents: number;
      /**
       * True when the provider emitted no usage frame and these numbers were
       * estimated locally (google / mistral / openrouter commonly emit none —
       * `stream_options.include_usage` is set only for openai upstream).
       */
      estimated: boolean;
    }
  | { type: "finish"; reason: GatewayFinishReason; provider: ModelProvider; model: string };

export type GatewayCompletion = {
  text: string;
  provider: ModelProvider;
  model: string;
  modelTier: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  estimated: boolean;
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
  | { type: "usage"; inputTokens: number; outputTokens: number };

/** Injection point used by the offline tests; the default hits the real providers. */
export type ProviderStreamFn = (
  provider: ModelProvider,
  model: string,
  input: { messages: GatewayMessage[]; temperature: number; maxTokens: number },
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
};

export interface ModelGateway {
  stream(req: GatewayStreamRequest): AsyncGenerator<GatewayStreamEvent>;
  complete(req: GatewayStreamRequest): Promise<GatewayCompletion>;
  resolveRoute(role?: StreamRole): GatewayRoute;
  configuredProviders(): ModelProvider[];
  estimateCostCents(input: { modelTier: ModelTier; inputTokens: number; outputTokens: number }): number;
}
