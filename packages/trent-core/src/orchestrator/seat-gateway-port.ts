/**
 * [P2-8] The seat port: the app's seat call, answered by the WRAPPER's model gateway.
 *
 * `apps/web/lib/model-gateway.ts` `executeSeatModel` takes an optional `createChatCompletion`
 * (`:84`) and, when one is given, calls it for each provider attempt instead of its own
 * `createProviderChatCompletion` (`:238-241`). The wrapper's seat guard already forwards one
 * (`./seat-guard.ts` `guardSeatModel`); until now production passed none, so every seat call went
 * through the app's client and `estimateModelCostCents` (`:194`) priced it by TIER — a
 * gemini-3.5-flash-lite seat billed at the sonnet tier's $3.00 per million input against a $0.30 list.
 *
 * This port answers each attempt through `ModelGateway.complete`, which brings what the app's client
 * lacks: real usage from the Trent Google streamer (include_usage, cached and thinking tokens), prompt
 * redaction, the bounded retry, `models.reasoning_effort`, and the pin policy — the app resolved the
 * model, the request names it, so `models.fallback_on_pin` decides whether the gateway may answer
 * with another provider inside this attempt. The app's own executor is left intact: its prompt, its
 * JSON parse, its semantic cache and its provider loop (each further attempt is another call here).
 *
 * Two things differ from the app's client and are handled here:
 *   - the gateway has no `response_format`, so the JSON request goes in the system message and the
 *     object is isolated from any lead-in or fence (`extractJsonObject`), as the planner port does;
 *   - an injected port turns OFF the app's configured-provider filter (`:210-212`), so a provider
 *     this profile has no key for is refused HERE, before any network call, and the app moves on.
 *
 * The gateway's own record of the call rides back on the reply under `trent_usage`, which the app
 * ignores and the run meter (`./spend-meter.ts`) reads. It carries counts and cents, never text.
 *
 * [L0-1] Under a provider ALIAS (`ollama`, `lmstudio`, `deepseek`, `groq`) the name rule below is not
 * asked: a pulled `mistral:7b` or `claude-local:8b` is the alias's model, and the gateway routes it by
 * the alias (`call-policy.ts` `planAttempts`). Under a local alias the app's provider chain is the
 * alias alone (`model-env.ts` writes `MODEL_ALLOWED_PROVIDERS`), so this port only ever sees its models.
 */

import { extractJsonObject } from "../model-gateway/completion-port.js";
import { activeProviderAlias } from "../model-gateway/providers.js";
import type { GatewayCompletion, GatewayMessage, ModelGateway, ModelProvider } from "../model-gateway/types.js";
import type { SeatChatCompletionFn, SeatChatRequest, SeatChatResponse } from "./types.js";

export const SEAT_JSON_INSTRUCTION =
  "Respond with exactly one JSON object and nothing else: no prose before or after it and no markdown fences.";

/** The app's `MAX_TOKENS.JSON` default (`apps/web/lib/ai-client.ts`, `OPENAI_MAX_TOKENS_JSON`, 8192). */
const DEFAULT_SEAT_MAX_TOKENS = 8192;

/** What the gateway billed for one seat attempt. Counts and cents only. */
export interface SeatCallUsage {
  readonly model: string;
  readonly provider: string;
  readonly providerAlias?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costCents: number;
  readonly estimated: boolean;
  readonly unpriced: boolean;
}

/** The reply the app reads, plus the gateway's record it does not. */
export type MeteredSeatChatResponse = SeatChatResponse & { readonly trent_usage: SeatCallUsage };

const USAGE_KEY = "trent_usage";
const PORT_MARK = Symbol.for("trent.orchestrator.seat-gateway-port");

/**
 * Which provider serves a model id: the same rule as `apps/web/lib/model-gateway.ts`
 * `inferProviderFromModel`, which the gateway itself uses to route a pinned model. Undefined for an
 * id it cannot name (an alias model such as `llama3.2`), which the gateway routes to its chain head.
 */
export function inferSeatProvider(model: string): ModelProvider | undefined {
  const id = model.toLowerCase();
  if (id.includes("claude")) return id.startsWith("anthropic/") ? "openrouter" : "anthropic";
  if (id.includes("gemini")) return "google";
  if (id.includes("mistral")) return "mistral";
  if (id.includes("gpt") || id.includes("codex") || /^o[13]/.test(id)) return "openai";
  return undefined;
}

function seatMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.OPENAI_MAX_TOKENS_JSON ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SEAT_MAX_TOKENS;
}

function toGatewayMessages(messages: SeatChatRequest["messages"]): GatewayMessage[] {
  const out: GatewayMessage[] = messages.map((message) => ({ role: message.role, content: message.content }));
  const first = out[0];
  if (first !== undefined && first.role === "system") out[0] = { role: "system", content: `${first.content}\n\n${SEAT_JSON_INSTRUCTION}` };
  else out.unshift({ role: "system", content: SEAT_JSON_INSTRUCTION });
  return out;
}

function usageOf(completion: GatewayCompletion): SeatCallUsage {
  return {
    model: completion.model,
    provider: completion.provider,
    ...(completion.providerAlias === undefined ? {} : { providerAlias: completion.providerAlias }),
    inputTokens: completion.inputTokens,
    outputTokens: completion.outputTokens,
    cachedInputTokens: completion.cachedInputTokens ?? 0,
    costCents: completion.costCents,
    estimated: completion.estimated,
    unpriced: completion.unpriced ?? false,
  };
}

/** The gateway-backed `createChatCompletion` the orchestrator installs for every seat by default. */
export function createSeatChatPort(gateway: ModelGateway): SeatChatCompletionFn {
  const port = async (request: SeatChatRequest): Promise<MeteredSeatChatResponse> => {
    const provider = activeProviderAlias() === undefined ? inferSeatProvider(request.model) : undefined; // [L0-1] by provider, never by name
    if (provider !== undefined && !gateway.configuredProviders().includes(provider)) {
      throw new Error(`${provider} is not configured for this profile (no API key); ${request.model} was not called`);
    }
    const completion = await gateway.complete({
      role: "executor",
      messages: toGatewayMessages(request.messages),
      model: request.model,
      temperature: request.temperature,
      maxTokens: seatMaxTokens(),
    });
    const cached = completion.cachedInputTokens ?? 0;
    return {
      choices: [{ message: { content: completion.text.trim() === "" ? null : extractJsonObject(completion.text) } }],
      usage: {
        prompt_tokens: completion.inputTokens,
        completion_tokens: completion.outputTokens,
        total_tokens: completion.inputTokens + completion.outputTokens,
        prompt_tokens_details: { cached_tokens: cached },
      } as SeatChatResponse["usage"],
      [USAGE_KEY]: usageOf(completion),
    };
  };
  Object.defineProperty(port, PORT_MARK, { value: true });
  return port;
}

/** True for a port this module built: its calls carry the gateway's record, so they can be metered. */
export function isMeteredSeatPort(fn: unknown): fn is SeatChatCompletionFn {
  return typeof fn === "function" && (fn as unknown as Record<symbol, unknown>)[PORT_MARK] === true;
}

/** The gateway's record on a reply this port produced; undefined on any other reply. */
export function readSeatCallUsage(reply: unknown): SeatCallUsage | undefined {
  if (typeof reply !== "object" || reply === null) return undefined;
  const usage = (reply as Record<string, unknown>)[USAGE_KEY];
  return typeof usage === "object" && usage !== null ? (usage as SeatCallUsage) : undefined;
}
