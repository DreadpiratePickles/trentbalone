/**
 * @trent/core model gateway — the wrapper that kills anti-pattern #1.
 *
 * It streams REAL tokens from a REAL provider by calling apps/web/lib/ai-client.ts
 * directly. It NEVER routes through apps/web/lib/ai-proxy/*, whose
 * `deterministicCompletion` (openai-compatible.ts:93) returns the canned literal
 * "Trent proxy response <sha8>".
 *
 * Traps handled (01_discovery/output/model-gateway-contract.md):
 *  1. MODELS (ai-client.ts:22-52) and MAX_TOKENS (:109) freeze at module load, so
 *     `createModelGateway` is async: it seeds process.env and THEN `await import()`s.
 *     A static top-level import of the web modules would break this.
 *  2. ai-proxy is never imported.
 *  3. `estimateModelCostCents` (model-gateway.ts:194) is the tier cost source; the
 *     wrapper overlays a per-model-id price (`pricing.ts`) because the tier table bills
 *     every model at Anthropic list. Costs are integer cents.
 *  4. Usage frames are provider-dependent; when absent they are estimated and the
 *     event is marked `estimated: true`.
 *  5. No AbortSignal upstream: cancellation breaks the `for await`, which calls the
 *     upstream generator's `return()`. We branch on `signal.aborted`, NEVER on
 *     `error.name` — an abort carrying a reason does not produce name "AbortError".
 */

import type {
  GatewayCompletion,
  GatewayMessage,
  GatewayRoute,
  GatewayStreamEvent,
  GatewayStreamRequest,
  ModelGateway,
  ModelGatewayConfig,
  ModelProvider,
  ModelTier,
  ProviderStreamFn,
  StreamRole,
} from "./types.js";

import { priceCall } from "./pricing.js";

export type * from "./types.js";
export { MODEL_PRICE_TABLE, priceCall, priceRowFor, normaliseModelId, type ModelPriceRow, type PricedCall, type PriceSource } from "./pricing.js";

const API_KEY_ENV: Record<ModelProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const ALL_PROVIDERS: ModelProvider[] = ["anthropic", "openai", "google", "mistral", "openrouter"];

const DEFAULT_MAX_TOKENS = 4096;

/** Rough local tokenizer used only when the provider emits no usage frame (trap 4). */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Seeds process.env. Values are never logged — see AGENTS.md invariant 7. */
function seedEnv(config: ModelGatewayConfig): void {
  for (const [provider, key] of Object.entries(config.apiKeys ?? {})) {
    if (key) process.env[API_KEY_ENV[provider as ModelProvider]] = key;
  }
  if (config.preferredProvider) process.env.MODEL_PREFERRED_PROVIDER = config.preferredProvider;
  if (config.allowedProviders?.length) {
    process.env.MODEL_ALLOWED_PROVIDERS = config.allowedProviders.join(",");
  }
  if (config.models?.executor) process.env.WORKBENCH_EXECUTOR_MODEL = config.models.executor;
  if (config.models?.planner) process.env.WORKBENCH_PLANNER_MODEL = config.models.planner;
  for (const [name, value] of Object.entries(config.env ?? {})) process.env[name] = value;
}

export async function createModelGateway(config: ModelGatewayConfig = {}): Promise<ModelGateway> {
  // Trap 1: env first…
  seedEnv(config);

  // …THEN the dynamic imports. Never hoist these to the top of the file.
  const [gatewayModule, clientModule, policyModule] = await Promise.all([
    import("@/lib/model-gateway"),
    import("@/lib/ai-client"),
    import("@/lib/model-policy"),
  ]);

  // Freeze the policy per gateway instance so a later gateway seeding different
  // env vars cannot retroactively change this one's routing.
  const policy = policyModule.buildModelPolicySnapshot();

  const defaultStreamProvider: ProviderStreamFn = async function* (provider, model, input) {
    if (provider === "anthropic") {
      yield* clientModule.streamAnthropicMessages({
        model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
      return;
    }
    yield* clientModule.streamOpenAiCompatibleChat(provider, {
      model,
      messages: input.messages,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
  };

  const streamFn = config.streamProvider ?? defaultStreamProvider;

  function resolveRoute(role: StreamRole = "executor"): GatewayRoute {
    const route = gatewayModule.routeWorkbenchStream(role, policy);
    return {
      providers: route.providers,
      fallbackChain: route.fallbackChain,
      modelTier: route.modelTier,
      explicitModel: route.explicitModel,
      modelForProvider: route.modelForProvider,
    };
  }

  function configuredProviders(): ModelProvider[] {
    return ALL_PROVIDERS.filter((provider) => clientModule.isProviderConfigured(provider));
  }

  function tierCostCents(input: { modelTier: ModelTier; inputTokens: number; outputTokens: number }): number {
    // Trap 3: model-gateway.ts:194 is the tier source of truth, not
    // ai-client.ts:530's divergent table. Integer cents, never floats.
    return gatewayModule.estimateModelCostCents(input);
  }

  function estimateCostCents(input: { modelTier: ModelTier; inputTokens: number; outputTokens: number; model?: string }): number {
    if (input.model === undefined) return tierCostCents(input);
    return priceCall({ model: input.model, modelTier: input.modelTier, inputTokens: input.inputTokens, outputTokens: input.outputTokens }, tierCostCents).costCents;
  }

  async function* stream(req: GatewayStreamRequest): AsyncGenerator<GatewayStreamEvent> {
    const role = req.role ?? "executor";
    const route = resolveRoute(role);
    const providers = req.provider ? [req.provider] : route.providers;

    if (providers.length === 0) {
      throw new Error(
        `model gateway: no configured provider in the chain [${route.fallbackChain.join(", ")}]. ` +
          "Seed an API key via createModelGateway({ apiKeys: … }).",
      );
    }

    const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = req.temperature ?? 0.2;
    const promptChars = req.messages.map((m) => m.content).join("\n");

    let lastError: unknown;

    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index]!;
      const model = route.modelForProvider(provider);

      let emittedToken = false;
      let aborted = false;
      let sawUsage = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: string | undefined;
      let text = "";

      if (req.signal?.aborted) {
        yield { type: "finish", reason: "aborted", provider, model };
        return;
      }

      try {
        // Breaking out of this loop calls the upstream generator's return(),
        // which closes the underlying reader. That is our cancellation (trap 5).
        for await (const frame of streamFn(provider, model, {
          messages: req.messages as GatewayMessage[],
          temperature,
          maxTokens,
        })) {
          if (req.signal?.aborted) {
            aborted = true;
            break;
          }
          if (frame.type === "token") {
            emittedToken = true;
            text += frame.content;
            yield { type: "token", content: frame.content, provider, model };
            if (req.signal?.aborted) {
              aborted = true;
              break;
            }
          } else if (frame.type === "usage") {
            sawUsage = true;
            inputTokens = frame.inputTokens;
            outputTokens = frame.outputTokens;
          } else if (frame.type === "finish") {
            finishReason = frame.reason;
          }
        }
      } catch (error) {
        // Trap 5: branch on signal.aborted, NOT on error.name.
        if (req.signal?.aborted) {
          aborted = true;
        } else {
          lastError = error;
          if (!emittedToken && index < providers.length - 1) continue;
          throw error;
        }
      }

      if (!sawUsage) {
        inputTokens = estimateTokens(promptChars);
        outputTokens = estimateTokens(text);
      }

      const priced = priceCall({ model, modelTier: route.modelTier, inputTokens, outputTokens }, tierCostCents);
      yield {
        type: "usage",
        provider,
        model,
        modelTier: route.modelTier,
        inputTokens,
        outputTokens,
        costCents: priced.costCents,
        estimated: !sawUsage,
        priced_as_default: priced.pricedAsDefault,
      };
      yield {
        type: "finish",
        reason: aborted ? "aborted" : (finishReason ?? "stop"),
        provider,
        model,
      };
      return;
    }

    throw lastError instanceof Error ? lastError : new Error("model gateway: fallback chain exhausted");
  }

  async function complete(req: GatewayStreamRequest): Promise<GatewayCompletion> {
    let text = "";
    let provider: ModelProvider = "google";
    let model = "";
    let modelTier: ModelTier = "sonnet";
    let inputTokens = 0;
    let outputTokens = 0;
    let costCents = 0;
    let estimated = true;
    let pricedAsDefault = true;
    let finishReason = "stop";

    for await (const event of stream(req)) {
      if (event.type === "token") {
        text += event.content;
        provider = event.provider;
        model = event.model;
      } else if (event.type === "usage") {
        provider = event.provider;
        model = event.model;
        modelTier = event.modelTier;
        inputTokens = event.inputTokens;
        outputTokens = event.outputTokens;
        costCents = event.costCents;
        estimated = event.estimated;
        pricedAsDefault = event.priced_as_default;
      } else {
        finishReason = event.reason;
      }
    }

    return { text, provider, model, modelTier, inputTokens, outputTokens, costCents, estimated, priced_as_default: pricedAsDefault, finishReason };
  }

  return { stream, complete, resolveRoute, configuredProviders, estimateCostCents };
}

export {
  createCompletionPort,
  extractJsonObject,
  NOT_CONFIGURED_MESSAGE,
  type CompletionPortCall,
  type CompletionPortOptions,
  type CreateCompletionFn,
} from "./completion-port.js";
