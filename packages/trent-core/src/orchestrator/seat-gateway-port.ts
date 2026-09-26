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
 *
 * [L1] Under a local provider (or `models.local.constrained_output: all`) the call is constrained: the
 * port asks for `{thought?, tool?, args?, final?}` under a JSON schema whose `tool` is an enum of the
 * seat's names, and re-renders the reply into the app's own shape (`./seat-constrained.ts`). A reply
 * that cannot be used is repaired, then re-asked ONCE with the error and the allowed names, then thrown
 * as a `SeatTurnError`: never a call with empty arguments (`model-gateway/tool-call-repair.ts`). Every
 * model call the port made rides back (`trent_usage` and `trent_usage_prior`), on the reply or on the
 * thrown error, so the meter records the re-ask as the model call it was.
 */

import { extractJsonObject } from "../model-gateway/completion-port.js";
import { activeProviderAlias } from "../model-gateway/providers.js";
import type { GatewayCompletion, GatewayMessage, GatewayStreamRequest, ModelGateway, ModelProvider } from "../model-gateway/types.js";
import type { SeatChatCompletionFn, SeatChatRequest, SeatChatResponse } from "./types.js";
// [L1] constrained seat turns
import { constrainedOutputApplies } from "../model-gateway/local-runtime.js";
import { reaskMessage, repairSeatTurn } from "../model-gateway/tool-call-repair.js";
import { readSeatTurnContext, renderSeatTurn, seatTurnFormat, SeatTurnError, withConstrainedInstruction, type SeatTurnContext } from "./seat-constrained.js";
import { escalate, escalationPolicyFromEnv } from "../model-gateway/escalation.js";
import { isLocalAlias } from "../model-gateway/providers.js";
// [/L1]

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

/** The reply the app reads, plus the gateway's record it does not. [L1] Earlier calls of the same turn (a re-ask) ride in `trent_usage_prior`. */
export type MeteredSeatChatResponse = SeatChatResponse & { readonly trent_usage: SeatCallUsage; readonly trent_usage_prior?: readonly SeatCallUsage[] };

const USAGE_KEY = "trent_usage";
const PRIOR_USAGE_KEY = "trent_usage_prior"; // [L1]
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

// [L1] constrained seat turns ─────────────────────────────────────────────────────

/** The usage fields for every call of one turn: the answering call last, the earlier ones before it. */
function usageFields(completions: readonly GatewayCompletion[]): { trent_usage: SeatCallUsage; trent_usage_prior?: SeatCallUsage[] } {
  const usages = completions.map(usageOf);
  const prior = usages.slice(0, -1);
  return { [USAGE_KEY]: usages.at(-1)!, ...(prior.length === 0 ? {} : { [PRIOR_USAGE_KEY]: prior }) } as { trent_usage: SeatCallUsage; trent_usage_prior?: SeatCallUsage[] };
}

/** A failure after at least one answered call still carries what those calls spent. */
function withSpent(error: unknown, completions: readonly GatewayCompletion[]): unknown {
  if (completions.length > 0 && typeof error === "object" && error !== null) Object.assign(error, usageFields(completions));
  return error;
}

function replyOf(content: string | null, completions: readonly GatewayCompletion[], earlier: readonly SeatCallUsage[] = []): MeteredSeatChatResponse {
  const usages = [...earlier, ...completions.map(usageOf)];
  const input = usages.reduce((sum, call) => sum + call.inputTokens, 0);
  const output = usages.reduce((sum, call) => sum + call.outputTokens, 0);
  const cached = usages.reduce((sum, call) => sum + call.cachedInputTokens, 0);
  const prior = usages.slice(0, -1);
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } } as SeatChatResponse["usage"],
    [USAGE_KEY]: usages.at(-1)!,
    ...(prior.length === 0 ? {} : { [PRIOR_USAGE_KEY]: prior }),
  } as MeteredSeatChatResponse;
}

/** The first reply clipped for the re-ask: the model sees what it wrote without doubling a long prompt. */
const REASK_ECHO_CHARS = 4_000;

async function constrainedSeatCall(gateway: ModelGateway, base: GatewayStreamRequest, context: SeatTurnContext): Promise<MeteredSeatChatResponse> {
  const messages = withConstrainedInstruction(base.messages, context);
  const completions: GatewayCompletion[] = [];
  const first = await gateway.complete({ ...base, messages, responseFormat: seatTurnFormat(context) });
  completions.push(first);
  let result = repairSeatTurn(first.text, { allowedTools: context.tools, truncated: first.finishReason === "length" });
  if (!result.ok) {
    const echo = first.text.trim() === "" ? "(an empty reply)" : first.text.slice(0, REASK_ECHO_CHARS);
    const reask: GatewayMessage[] = [...messages, { role: "assistant", content: echo }, { role: "user", content: reaskMessage(result.failure, context.tools) }];
    const requireTool = result.failure.kind === "no_action" && context.tools.length > 0;
    const second = await gateway.complete({ ...base, messages: reask, responseFormat: seatTurnFormat(context, { requireTool }) }).catch((error: unknown) => {
      throw withSpent(error, completions);
    });
    completions.push(second);
    result = repairSeatTurn(second.text, { allowedTools: context.tools, truncated: second.finishReason === "length" });
    if (!result.ok) throw withSpent(new SeatTurnError(result.failure), completions);
  }
  return replyOf(JSON.stringify(renderSeatTurn(result.turn, context)), completions);
}

/**
 * `models.escalate` with `step_failed`: a seat call that failed on the LOCAL model (unusable after its
 * re-ask, or a provider error) is offered to the hosted model through the approval gate, on today's
 * path (the app's own JSON instruction, no schema). Held: the failure stands and its message names the
 * row to approve. Anything else rethrows the local failure unchanged. A cancelled call is never offered.
 */
async function escalateFailedSeat(gateway: ModelGateway, base: GatewayStreamRequest, request: SeatChatRequest, error: unknown): Promise<MeteredSeatChatResponse> {
  const policy = escalationPolicyFromEnv();
  const cancelled = error instanceof Error && error.name === "AbortError";
  if (cancelled || policy === undefined || !policy.on.includes("step_failed") || !isLocalAlias(activeProviderAlias())) throw error;
  const seat = /^Seat: (\S+)$/m.exec(request.messages.map((message) => message.content).join("\n"))?.[1];
  const outcome = await escalate({ role: "step_failed", request: base, gateway, policy, ...(seat === undefined ? {} : { seat }) });
  const spent = readSeatCallUsages(error);
  if (outcome.kind === "answered") {
    const text = outcome.completion.text;
    return replyOf(text.trim() === "" ? null : extractJsonObject(text), [outcome.completion], spent);
  }
  if (outcome.kind !== "held") throw error;
  const reason = error instanceof Error ? error.message : String(error);
  const held = new Error(`${reason}; hosted escalation is waiting: ${outcome.summary}`);
  if (spent.length > 0) Object.assign(held, { [USAGE_KEY]: spent.at(-1), ...(spent.length > 1 ? { [PRIOR_USAGE_KEY]: spent.slice(0, -1) } : {}) });
  throw held;
}
// [/L1]

/** The gateway-backed `createChatCompletion` the orchestrator installs for every seat by default. */
export function createSeatChatPort(gateway: ModelGateway): SeatChatCompletionFn {
  const port = async (request: SeatChatRequest): Promise<MeteredSeatChatResponse> => {
    const provider = activeProviderAlias() === undefined ? inferSeatProvider(request.model) : undefined; // [L0-1] by provider, never by name
    if (provider !== undefined && !gateway.configuredProviders().includes(provider)) {
      throw new Error(`${provider} is not configured for this profile (no API key); ${request.model} was not called`);
    }
    const base: GatewayStreamRequest = { role: "executor", messages: toGatewayMessages(request.messages), model: request.model, temperature: request.temperature, maxTokens: seatMaxTokens() }; // [L1] shared by both paths
    if (constrainedOutputApplies()) return constrainedSeatCall(gateway, base, readSeatTurnContext(request.messages)).catch((error: unknown) => escalateFailedSeat(gateway, base, request, error)); // [L1]
    let completion: GatewayCompletion;
    try {
      completion = await gateway.complete(base);
    } catch (error) {
      return escalateFailedSeat(gateway, base, request, error); // [L1] step_failed
    }
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

/** [L1] Every call one port call made, earlier ones first, from a reply or a thrown error; [] on anything else. */
export function readSeatCallUsages(replyOrError: unknown): SeatCallUsage[] {
  const last = readSeatCallUsage(replyOrError);
  if (last === undefined) return [];
  const prior = (replyOrError as Record<string, unknown>)[PRIOR_USAGE_KEY];
  return [...(Array.isArray(prior) ? (prior as SeatCallUsage[]) : []), last];
}
