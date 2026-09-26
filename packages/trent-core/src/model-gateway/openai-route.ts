/**
 * [L0-2] `provider: "openai"` through the wrapper's own client (audit G2): OpenAI itself, and the four
 * OpenAI-compatible aliases `providers.ts` resolves to it (`ollama`, `lmstudio`, `deepseek`, `groq`).
 *
 * The route is read from the same variables the app's client reads (`OPENAI_API_KEY`,
 * `OPENAI_BASE_URL`, and for OpenAI itself `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`, which openai-node
 * 4.104.0 sends as `OpenAI-Organization` / `OpenAI-Project`), and the body carries the app's own
 * per-model tuning (`modelChatTuning`: `max_completion_tokens` and no temperature for gpt-5 and the
 * o-series), so a hosted call's request is the one the app sent, plus `include_usage`.
 *
 * `reasoning_effort` is sent only where the provider documents it for chat completions:
 *   - OpenAI: reasoning models only (the same `gpt-5|o1|o3|o4` family the app tunes); others refuse it.
 *   - Ollama: "reasoning_effort and reasoning.effort control model thinking. Use /api/show to discover
 *     each model's supported values" (https://docs.ollama.com/api/openai-compatibility), so it is sent
 *     when `/api/show` lists `thinking` and dropped otherwise.
 *   - llama.cpp accepts it too ("If `none`, reasoning/thinking is disabled", tools/server/README.md),
 *     but has no alias of its own; behind an alias it follows that alias's rule.
 *   - LM Studio: absent from the chat-completions parameter list
 *     (https://lmstudio.ai/docs/developer/openai-compat/chat-completions). DeepSeek and Groq: accepted
 *     values are per model, so nothing is sent rather than a value a model refuses.
 * A dropped effort is logged by the caller as `model_gateway.reasoning_effort_not_sent`.
 */

import type { ReasoningEffort } from "./call-policy.js";
import { ollamaCapabilities } from "./local-probe.js";
import { acquireLocalSlot, localFetch, localModelPolicy } from "./local-runtime.js";
import { streamCompatChat, type FetchLike } from "./openai-compat.js";
import { activeProviderAlias, aliasBaseUrl, isLocalAlias, type ProviderAlias } from "./providers.js";
import { responseFormatFor } from "./response-format.js"; // [L1]
import type { GatewayMessage, GatewayResponseFormat, ProviderStreamFrame } from "./types.js"; // [L1] GatewayResponseFormat

/** openai-node's default when `OPENAI_BASE_URL` is unset. */
export const OPENAI_COMPAT_BASE_URL = "https://api.openai.com/v1";

const OPENAI_REASONING_MODEL = /^(gpt-5|o1|o3|o4)/i;

export interface OpenAiRoute {
  /** `openai`, or the alias the run is routed through. Named in errors and logs. */
  readonly label: string;
  readonly alias?: ProviderAlias;
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/** The endpoint and key the app's client would use for `openai`. Values are read, never logged. */
export function resolveOpenAiRoute(env: NodeJS.ProcessEnv = process.env): OpenAiRoute {
  const alias = activeProviderAlias(env);
  const baseUrl = envValue(env, "OPENAI_BASE_URL") ?? (alias === undefined ? OPENAI_COMPAT_BASE_URL : aliasBaseUrl(alias, env));
  const headers: Record<string, string> = {};
  const organization = envValue(env, "OPENAI_ORG_ID");
  const project = envValue(env, "OPENAI_PROJECT_ID");
  if (alias === undefined && organization !== undefined) headers["openai-organization"] = organization;
  if (alias === undefined && project !== undefined) headers["openai-project"] = project;
  const apiKey = envValue(env, "OPENAI_API_KEY");
  return { label: alias ?? "openai", ...(alias === undefined ? {} : { alias }), ...(apiKey === undefined ? {} : { apiKey }), baseUrl, headers };
}

export interface OpenAiRouteInput {
  readonly messages: GatewayMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
  readonly reasoningEffort?: ReasoningEffort;
  readonly responseFormat?: GatewayResponseFormat; // [L1]
}

export interface OpenAiRouteDeps {
  /** The app's `modelChatTuning`: the body fields for this model's size and temperature. */
  readonly tuning: (model: string, maxTokens: number, temperature?: number) => Record<string, unknown>;
  readonly onEffortDropped: (fields: { provider: string; model: string; reason: string }) => void;
  /** [L1] The gateway's response-format decision for this route's label (`response-format.ts`). */
  readonly responseFormatFor?: (label: string, format: GatewayResponseFormat | undefined) => GatewayResponseFormat | undefined;
  readonly fetchImpl?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
}

async function sendableEffort(route: OpenAiRoute, model: string, effort: ReasoningEffort | undefined, deps: OpenAiRouteDeps): Promise<ReasoningEffort | undefined> {
  if (effort === undefined) return undefined;
  const drop = (reason: string): undefined => {
    deps.onEffortDropped({ provider: route.label, model, reason });
    return undefined;
  };
  if (route.alias === undefined) return OPENAI_REASONING_MODEL.test(model) ? effort : drop("OpenAI accepts reasoning_effort on reasoning models only");
  if (route.alias !== "ollama") return drop(`${route.label} documents no reasoning_effort on chat completions`);
  // [L1] `none` is `think: false`, which Ollama accepts from every model: its ChatHandler refuses only a
  // truthy think on a model without the capability (server/routes.go), so the local seat default needs no probe.
  if (effort === "none") return effort;
  const capabilities = await ollamaCapabilities({ baseUrl: route.baseUrl, model, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  if (capabilities?.includes("thinking")) return effort;
  return drop(capabilities === undefined ? "Ollama's /api/show could not be read" : "the model's /api/show capabilities do not include thinking");
}

/** One attempt on the `openai` route. A local alias waits for a slot first, then streams under its budgets. */
export async function* streamOpenAiRoute(model: string, input: OpenAiRouteInput, deps: OpenAiRouteDeps): AsyncGenerator<ProviderStreamFrame> {
  const env = deps.env ?? process.env;
  const route = resolveOpenAiRoute(env);
  if (route.apiKey === undefined) throw new Error("OPENAI_API_KEY is not configured");
  const local = route.alias !== undefined && isLocalAlias(route.alias) ? localModelPolicy(route.alias, env) : undefined;
  const reasoningEffort = await sendableEffort(route, model, input.reasoningEffort, deps);
  const responseFormat = (deps.responseFormatFor ?? responseFormatFor)(route.label, input.responseFormat); // [L1]
  const release = local === undefined ? undefined : await acquireLocalSlot(route.baseUrl, local.maxInFlight, input.signal);
  try {
    yield* streamCompatChat(
      {
        model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        tuning: deps.tuning(model, input.maxTokens, input.temperature),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        ...(responseFormat === undefined ? {} : { responseFormat }), // [L1]
        ...(input.signal ? { signal: input.signal } : {}),
      },
      {
        apiKey: route.apiKey,
        baseUrl: route.baseUrl,
        label: route.label,
        headers: route.headers,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : local === undefined ? {} : { fetchImpl: localFetch }),
        ...(local === undefined ? {} : { local: { ttftMs: local.ttftMs, idleMs: local.idleMs } }),
      },
    );
  } finally {
    release?.();
  }
}
