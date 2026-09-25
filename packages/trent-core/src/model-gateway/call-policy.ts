/**
 * [P1-C] The two per-call policies of the `models` config block, and the provider plan they shape.
 *
 * PINNED MODELS. A request that names its model (`GatewayStreamRequest.model`: a seat pin, a
 * `--model` flag, a cron pin) is EXPLICIT; a request that names none takes the route's configured
 * model and is DEFAULT-RESOLVED. A default-resolved request falls back across the configured
 * provider chain exactly as before. An explicit one is answered by the model it named or not at
 * all: a provider failure ends the call with that provider's own error and no other provider is
 * tried, so no other model is billed and the ledger never learns after the fact that a cheap pin
 * was answered by an expensive tier. `models.fallback_on_pin: true` restores the chain for a pin.
 * Same-model retries of a transient failure (429, 5xx; `retry.ts`) still happen: they ask the same
 * model again, which is what the pin asked for.
 *
 * REASONING EFFORT. `models.reasoning_effort` is sent as `reasoning_effort` on the call when set and
 * omitted when not, so an unconfigured profile sends exactly the body it sent before. The accepted
 * values are Google's, from https://ai.google.dev/gemini-api/docs/openai ("Thinking", read
 * 2026-09-25): `minimal`, `low`, `medium`, `high`, and `none`, which Google accepts for 2.5 models
 * only ("Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"). Omitted, "Gemini uses the
 * model's default level or budget". Only the Trent-side Google streamer (`openai-compat.ts`) can
 * carry it; the app's streamer for the other providers takes no such field.
 *
 * Both reach a gateway built with no arguments (the orchestrator's) through an env bridge written
 * from config by `orchestrator/model-env.ts`, the same road `model_overrides` takes.
 */

import type { ModelProvider } from "./types.js";

/** Google's accepted values, in the order the docs list them after `none`. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** The bridge variables. Names only; neither ever carries a secret. */
export const MODEL_CALL_ENV = {
  fallbackOnPin: "TRENT_MODEL_FALLBACK_ON_PIN",
  reasoningEffort: "TRENT_REASONING_EFFORT",
} as const;

/** The slice of the `models` block this module reads; `ModelTiersConfig` satisfies it. */
export interface ModelCallConfig {
  readonly fallback_on_pin?: boolean;
  readonly reasoning_effort?: string;
}

export interface ModelCallPolicy {
  readonly fallbackOnPin: boolean;
  readonly reasoningEffort?: ReasoningEffort;
}

/** Writes what is configured, and nothing else. Returns the variable NAMES written. */
export function applyModelCallEnv(models: ModelCallConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const written: string[] = [];
  if (typeof models?.fallback_on_pin === "boolean") {
    env[MODEL_CALL_ENV.fallbackOnPin] = String(models.fallback_on_pin);
    written.push(MODEL_CALL_ENV.fallbackOnPin);
  }
  if (isReasoningEffort(models?.reasoning_effort)) {
    env[MODEL_CALL_ENV.reasoningEffort] = models.reasoning_effort;
    written.push(MODEL_CALL_ENV.reasoningEffort);
  }
  return written;
}

/** Reads the bridge. Anything but the literal `true` keeps a pin pinned; an unknown effort is not sent. */
export function modelCallPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ModelCallPolicy {
  const effort = env[MODEL_CALL_ENV.reasoningEffort]?.trim();
  return {
    fallbackOnPin: env[MODEL_CALL_ENV.fallbackOnPin]?.trim().toLowerCase() === "true",
    ...(isReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  };
}

/** One provider the request may be answered by, and the model that provider is asked for. */
export interface PlannedAttempt {
  readonly provider: ModelProvider;
  readonly model: string;
}

export interface AttemptPlanInput {
  /** `GatewayStreamRequest.model`. Blank is the same as absent. */
  readonly requestModel?: string;
  /** `GatewayStreamRequest.provider`: forces one provider, pinned or not (unchanged behaviour). */
  readonly requestProvider?: ModelProvider;
  /** The configured chain, in order (`GatewayRoute.providers`). */
  readonly routeProviders: readonly ModelProvider[];
  readonly modelForProvider: (provider: ModelProvider) => string;
  /** Which provider serves a model id (`apps/web` `inferProviderFromModel`). */
  readonly inferProvider: (model: string) => ModelProvider | undefined;
  readonly fallbackOnPin: boolean;
}

export interface AttemptPlan {
  readonly attempts: readonly PlannedAttempt[];
  /** True when the request named its model. Logged on every provider failure. */
  readonly pinned: boolean;
}

export function planAttempts(input: AttemptPlanInput): AttemptPlan {
  const pin = input.requestModel?.trim();
  if (pin === undefined || pin === "") {
    const providers = input.requestProvider ? [input.requestProvider] : input.routeProviders;
    return { attempts: providers.map((provider) => ({ provider, model: input.modelForProvider(provider) })), pinned: false };
  }
  const provider = input.requestProvider ?? input.inferProvider(pin) ?? input.routeProviders[0];
  if (provider === undefined) return { attempts: [], pinned: true };
  const primary: PlannedAttempt = { provider, model: pin };
  if (input.requestProvider !== undefined || !input.fallbackOnPin) return { attempts: [primary], pinned: true };
  const rest = input.routeProviders
    .filter((other) => other !== provider)
    .map((other) => ({ provider: other, model: input.modelForProvider(other) }));
  return { attempts: [primary, ...rest], pinned: true };
}
