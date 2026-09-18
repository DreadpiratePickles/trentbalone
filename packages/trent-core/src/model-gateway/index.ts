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
 *  5. No AbortSignal support upstream: cancellation breaks the `for await`, which calls the
 *     upstream generator's `return()`. We branch on `signal.aborted`, NEVER on
 *     `error.name` — an abort carrying a reason does not produce name "AbortError".
 *
 * Two behaviours were added after the harness audit (A.4 / A.7, shortfalls D-6 and D-7):
 *
 *  - RETRY. Every provider attempt is wrapped in a bounded retry (`retry.ts`): transient failures
 *    only (429, 5xx, network), `Retry-After` honoured, exponential backoff with full jitter, then
 *    the next provider in the fallback chain. The existing "do not fall back once a token was
 *    emitted" rule is kept and also forbids a RETRY — replaying a half-delivered answer would
 *    duplicate it for the reader.
 *
 *  - ALIASES. The four OpenAI-compatible endpoints the config accepts (`ollama`, `lmstudio`,
 *    `deepseek`, `groq`) are resolved at the boundary by `providers.ts` into `provider: "openai"`
 *    plus a base URL, so no new provider identity leaks into the read-only app, its doctor probes
 *    or its tier tables. The usage row still names the alias, so the ledger stays honest.
 *
 * Cancellation detail for the retry path: every `next()` on the upstream generator races the run's
 * AbortSignal, so an in-flight request can never hold the run open, and the generator's `return()`
 * is invoked to close it. The signal is also forwarded into `ProviderStreamFn`, which is what
 * aborts the socket for any implementation that accepts one; the app's own two stream functions
 * take no signal, and giving them one would mean editing read-only `apps/web`.
 */

import type {
  GatewayCompletion,
  GatewayMessage,
  GatewayRoute,
  GatewayStreamEvent,
  GatewayStreamRequest,
  ModelGateway,
  ModelGatewayConfig,
  ModelOverrides,
  ModelProvider,
  ModelTier,
  ProviderStreamFn,
  StreamRole,
} from "./types.js";

import { runProviderAttempts } from "./attempts.js";
import { modelOverridesFromEnv, priceCall } from "./pricing.js";
import {
  PROVIDER_ALIAS_ROUTES,
  activeProviderAlias,
  applyProviderAliasEnv,
  resolveProviderAlias,
  type ProviderAlias,
} from "./providers.js";
import { createPromptRedactor, privacyFromEnv } from "./redact.js";
import { abortableSleep, classifyProviderError, resolveRetryPolicy } from "./retry.js";
import { StructuredLogger } from "../telemetry/logger.js";
import { EXIT, TrentError } from "../errors/index.js";

export type * from "./types.js";
export {
  MODEL_OVERRIDES_ENV,
  MODEL_PRICE_PREFIXES,
  MODEL_PRICE_TABLE,
  applyModelOverridesEnv,
  contextWindowFor,
  modelOverridesFromEnv,
  normaliseModelId,
  priceCall,
  priceRowFor,
  type ModelPriceRow,
  type PriceSource,
  type PricedCall,
  type PricePrefixRule,
} from "./pricing.js";
export {
  ALIAS_ENV,
  KEYLESS_ALIASES,
  LOCAL_PLACEHOLDER_KEY,
  PROVIDER_ALIASES,
  PROVIDER_ALIAS_ROUTES,
  activeProviderAlias,
  aliasApiKey,
  aliasBaseUrl,
  aliasEnvKeys,
  applyProviderAliasEnv,
  isLocalAlias,
  isProviderAlias,
  resolveProviderAlias,
  type AliasEnvReport,
  type ProviderAlias,
  type ProviderAliasRoute,
} from "./providers.js";
export {
  DEFAULT_RETRY_POLICY,
  ProviderHttpError,
  abortableSleep,
  classifyProviderError,
  parseRetryAfter,
  resolveRetryPolicy,
  retryDelayMs,
  type ClassifiedFailure,
  type ErrorClass,
  type RetryPolicy,
} from "./retry.js";
export {
  applyPrivacyEnv,
  createPromptRedactor,
  privacyFromEnv,
  redactionToken,
  PRIVACY_ENV,
  type PromptPrivacyConfig,
  type PromptRedactor,
  type RedactedMessages,
  type RedactedText,
  type RedactionHit,
} from "./redact.js";

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
  // A surface that builds its own gateway (`trent heartbeat`, `trent improve`) passes the
  // CONFIGURED provider, which may be an alias the app's router would silently drop. Resolve it
  // here too, and refuse to build rather than route the run somewhere the user did not choose.
  const alias = resolveProviderAlias(config.preferredProvider);
  if (alias) {
    const report = applyProviderAliasEnv(alias.alias, config.models?.executor ?? "");
    if (report.unroutable !== undefined) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "model.route",
        message: report.unroutable,
        target: alias.alias,
      });
    }
  } else if (config.preferredProvider) process.env.MODEL_PREFERRED_PROVIDER = config.preferredProvider;
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

  // T3.2: prompts are redacted here, at the one point every message leaves for a provider. A bad
  // user pattern throws now (exit code 3), so the operator learns at startup, not mid-run.
  const privacy = config.privacy ?? privacyFromEnv();
  const redactor = createPromptRedactor({ enabled: privacy.redact_prompts, patterns: privacy.patterns });
  const redactionLogger = config.redactionLog === undefined ? new StructuredLogger({ runId: "model-gateway" }) : undefined;
  const redactionLog = config.redactionLog ?? ((event, fields) => redactionLogger?.info(event, fields));

  const retryPolicy = resolveRetryPolicy(config.retry);
  const sleepFn = config.retry?.sleep ?? abortableSleep;
  const randomFn = config.retry?.random;
  const retryLogger = config.retryLog === undefined ? new StructuredLogger({ runId: "model-gateway" }) : undefined;
  const retryLog = config.retryLog ?? ((event: string, fields: Record<string, unknown>) => retryLogger?.warn(event, fields));
  const overrides: ModelOverrides = config.modelOverrides ?? modelOverridesFromEnv();

  /** The model an aliased route uses. Read from env per call: the bridge may be written late. */
  function aliasModelFor(alias: ProviderAlias, role: StreamRole): string {
    const configured = role === "planner" ? config.models?.planner : config.models?.executor;
    const fromEnv = role === "planner" ? process.env.WORKBENCH_PLANNER_MODEL : process.env.WORKBENCH_EXECUTOR_MODEL;
    const chosen = configured ?? fromEnv ?? process.env.OPENAI_MODEL_DEFAULT ?? PROVIDER_ALIAS_ROUTES[alias].defaultModel;
    return chosen.trim();
  }

  function resolveRoute(role: StreamRole = "executor"): GatewayRoute {
    const route = gatewayModule.routeWorkbenchStream(role, policy);
    const alias = activeProviderAlias();
    if (alias === undefined) {
      return {
        providers: route.providers,
        fallbackChain: route.fallbackChain,
        modelTier: route.modelTier,
        explicitModel: route.explicitModel,
        modelForProvider: route.modelForProvider,
      };
    }
    // The aliased slot IS the alias endpoint, and `MODELS` in ai-client.ts froze at import time,
    // so the app's resolver cannot be trusted to name the model an alias run is actually using.
    const aliasProvider = PROVIDER_ALIAS_ROUTES[alias].provider;
    const aliasModel = aliasModelFor(alias, role);
    return {
      providers: route.providers,
      fallbackChain: route.fallbackChain,
      modelTier: route.modelTier,
      explicitModel: aliasModel,
      modelForProvider: (provider) => (provider === aliasProvider ? aliasModel : route.modelForProvider(provider)),
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
    const alias = activeProviderAlias();
    return priceCall(
      {
        model: input.model,
        modelTier: input.modelTier,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        overrides,
        ...(alias ? { alias } : {}),
      },
      tierCostCents,
    ).costCents;
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
    // Every message content, system prompt and tool results included; hit counts only are logged.
    const redacted = redactor.redactMessages(req.messages);
    const messages = redacted.messages;
    if (redactor.enabled && redacted.hits.length > 0) {
      redactionLog("prompt.redacted", { role, messageCount: messages.length, hits: redacted.hits });
    }
    const promptChars = messages.map((m) => m.content).join("\n");
    const alias = activeProviderAlias();
    const aliasField = alias ? { providerAlias: alias } : {};

    let lastError: unknown;

    for (let index = 0; index < providers.length; index++) {
      const provider = providers[index]!;
      const model = route.modelForProvider(provider);

      if (req.signal?.aborted) {
        yield { type: "finish", reason: "aborted", provider, model };
        return;
      }

      let failure: unknown;
      let emittedToken = false;
      let settled = false;

      for await (const outcome of runProviderAttempts({
        streamFn,
        provider,
        model,
        messages: messages as GatewayMessage[],
        temperature,
        maxTokens,
        retryPolicy,
        log: retryLog,
        logFields: aliasField,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(sleepFn ? { sleep: sleepFn } : {}),
        ...(randomFn ? { random: randomFn } : {}),
      })) {
        if (outcome.kind === "token") {
          emittedToken = true;
          yield { type: "token", content: outcome.content, provider, model };
          continue;
        }
        if (outcome.kind === "aborted") {
          yield { type: "finish", reason: "aborted", provider, model };
          return;
        }
        if (outcome.kind === "complete") {
          const inputTokens = outcome.sawUsage ? outcome.inputTokens : estimateTokens(promptChars);
          const outputTokens = outcome.sawUsage ? outcome.outputTokens : estimateTokens(outcome.text);
          const priced = priceCall(
            { model, modelTier: route.modelTier, inputTokens, outputTokens, provider, overrides, ...(alias ? { alias } : {}) },
            tierCostCents,
          );
          yield {
            type: "usage",
            provider,
            model,
            modelTier: route.modelTier,
            inputTokens,
            outputTokens,
            costCents: priced.costCents,
            estimated: !outcome.sawUsage,
            priced_as_default: priced.pricedAsDefault,
            unpriced: priced.unpriced,
            ...aliasField,
          };
          yield {
            type: "finish",
            reason: outcome.aborted ? "aborted" : (outcome.finishReason ?? "stop"),
            provider,
            model,
          };
          return;
        }
        failure = outcome.error;
        emittedToken = outcome.emittedToken;
        settled = true;
      }

      if (!settled) throw new Error("model gateway: provider attempts ended without an outcome");

      lastError = failure;
      // The audit's rule, kept: a half-delivered answer is never replayed on another provider.
      const willFallBack = !emittedToken && index < providers.length - 1;
      retryLog("model_gateway.provider_failed", {
        provider,
        model,
        errorClass: classifyProviderError(failure).errorClass,
        willFallBack,
        ...aliasField,
      });
      if (willFallBack) continue;
      throw failure instanceof Error ? failure : new Error(String(failure));
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
    let unpriced = true;
    let providerAlias: string | undefined;
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
        unpriced = event.unpriced;
        providerAlias = event.providerAlias;
      } else {
        finishReason = event.reason;
      }
    }

    return {
      text,
      provider,
      model,
      modelTier,
      inputTokens,
      outputTokens,
      costCents,
      estimated,
      priced_as_default: pricedAsDefault,
      unpriced,
      ...(providerAlias === undefined ? {} : { providerAlias }),
      finishReason,
    };
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
