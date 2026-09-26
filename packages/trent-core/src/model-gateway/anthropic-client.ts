/**
 * [C14] The Trent-side client for the Anthropic Messages API (council verdict C14).
 *
 * Why it exists. `anthropic` streamed through `apps/web/lib/ai-client.ts` `streamAnthropicMessages`
 * (read-only), which posts to a hardcoded `https://api.anthropic.com` with `system` as a plain string, no
 * `tools`, no `cache_control`, reads `input_tokens` only, and takes no AbortSignal. The strongest tool
 * model was sent no tool schemas and billed the same prefix in full on every turn.
 *
 * Prompt caching (https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-09-26):
 * up to 4 breakpoints; the cached prefix is built in the order tools, system, messages. This client places
 * Hermes's four (`agent/prompt_caching.py:3-5`): the last tool definition, the system block, and the last
 * two user turns. The breakpoint on the newest user turn writes the conversation so far; on the next
 * request it is the second-newest and reads it back. Every marker is the default 5-minute
 * `{"type": "ephemeral"}`. A prefix shorter than the model's minimum is simply not cached (no error).
 */

import type { ReasoningEffort } from "./call-policy.js";
import { ProviderHttpError } from "./retry.js";
import type { FetchLike } from "./openai-compat.js";
import type { GatewayCompletion, GatewayMessage, GatewayStreamEvent, GatewayToolCall, GatewayToolDefinition, ProviderContentBlock, ProviderStreamFrame } from "./types.js";

/** The SDK's default when `ANTHROPIC_BASE_URL` is unset. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Time allowed for the response headers when nothing is configured: the 60 s every hosted route allows
 * (`openai-compat.ts` `COMPAT_HEADERS_TIMEOUT_MS`). The stream itself has no clock: a long answer is not a
 * stall, and the run's AbortSignal ends it. Set by config `anthropicTimeoutMs`, else this env variable.
 */
export const ANTHROPIC_HEADERS_TIMEOUT_MS = 60_000;
export const ANTHROPIC_TIMEOUT_ENV = "TRENT_ANTHROPIC_TIMEOUT_MS";

const EPHEMERAL = { type: "ephemeral" } as const;
/** Breakpoints spent on the conversation: the newest two user turns. */
const MESSAGE_BREAKPOINTS = 2;

export interface AnthropicRoute {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly headersTimeoutMs?: number; // default ANTHROPIC_HEADERS_TIMEOUT_MS
}

export interface AnthropicInput {
  readonly model: string;
  readonly messages: readonly GatewayMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly tools?: readonly GatewayToolDefinition[];
  readonly signal?: AbortSignal;
  readonly reasoningEffort?: ReasoningEffort;
  /** Told when `reasoningEffort` cannot be sent to this model (the gateway logs `reasoning_effort_not_sent`). */
  readonly onEffortDropped?: (reason: string) => void;
}

/**
 * What a model family accepts, by the longest matching id prefix. Read 2026-09-26:
 *   - `effort`: `output_config.effort`, low / medium / high on every listed model
 *     (https://platform.claude.com/docs/en/build-with-claude/effort, `supportedModels`).
 *   - `budget`: manual thinking, `thinking: {type: "enabled", budget_tokens}`, the only thinking mode on 4.5 and
 *     earlier and rejected with a 400 on 4.7 and later
 *     (https://platform.claude.com/docs/en/build-with-claude/extended-thinking). Opus 4.5 takes both ("set both").
 *   - `sampling`: a non-default `temperature` is accepted. It "returns a 400 error" on Opus 4.7 and later and on
 *     Sonnet 5 (https://platform.claude.com/docs/en/models/opus-5-5/migration-guide,
 *     https://platform.claude.com/docs/en/models/sonnet-5/migration-guide); Haiku 4.5 accepts it.
 * A model on no row gets none of the three: omitting a field is always valid, sending one is a guess.
 */
interface ModelTraits {
  readonly effort: boolean;
  readonly budget: boolean;
  readonly sampling: boolean;
}

const LEGACY: ModelTraits = { effort: false, budget: true, sampling: true };
const ADAPTIVE: ModelTraits = { effort: true, budget: false, sampling: false };
const MODEL_TRAITS: ReadonlyArray<readonly [string, ModelTraits]> = [
  ["claude-3", { effort: false, budget: false, sampling: true }],
  ["claude-3-7-sonnet", LEGACY],
  ["claude-haiku-4-5", LEGACY],
  ["claude-sonnet-4", LEGACY],
  ["claude-opus-4", LEGACY],
  ["claude-opus-4-5", { effort: true, budget: true, sampling: true }],
  ["claude-sonnet-4-6", { effort: true, budget: false, sampling: true }],
  ["claude-opus-4-6", { effort: true, budget: false, sampling: true }],
  ["claude-opus-4-7", ADAPTIVE],
  ["claude-opus-4-8", ADAPTIVE],
  ["claude-opus-5", ADAPTIVE],
  ["claude-sonnet-5", ADAPTIVE],
  ["claude-fable-5", ADAPTIVE],
  ["claude-mythos", ADAPTIVE],
];

function traitsOf(model: string): ModelTraits | undefined {
  const id = model.slice(model.lastIndexOf("/") + 1).trim().toLowerCase();
  let best: readonly [string, ModelTraits] | undefined;
  for (const rule of MODEL_TRAITS) if (id.startsWith(rule[0]) && (best === undefined || rule[0].length > best[0].length)) best = rule;
  return best?.[1];
}

type SentEffort = Exclude<ReasoningEffort, "none">;
/** Trent's effort -> Anthropic's level. `minimal` is the lowest Anthropic level. */
const EFFORT_LEVEL: Readonly<Record<SentEffort, "low" | "medium" | "high">> = { minimal: "low", low: "low", medium: "medium", high: "high" };
/**
 * Trent's effort -> a thinking budget. The docs' anchors: "start near the 1,024-token minimum" for simple tasks,
 * "16,000 tokens or more" for complex ones; medium is Hermes's 8,000 (`agent/anthropic_adapter.py:62`).
 */
const THINKING_BUDGET: Readonly<Record<SentEffort, number>> = { minimal: 1_024, low: 1_024, medium: 8_000, high: 16_000 };

/**
 * `max_tokens`, `temperature`, `output_config` and `thinking` for this model. A budget must be below `max_tokens`
 * and counts toward it, so `max_tokens` grows by the budget and the answer keeps the room it asked for.
 * Thinking "isn't compatible with temperature ... modifications", so a budget request sends none.
 */
function modelFields(input: Omit<AnthropicInput, "signal">): Record<string, unknown> {
  const traits = traitsOf(input.model);
  const effort = input.reasoningEffort;
  const fields: Record<string, unknown> = { max_tokens: input.maxTokens };
  let thinking = false;
  if (effort === "none") {
    // Honoured by omission on a manual-thinking model (thinking is off unless asked for); not otherwise.
    if (traits?.budget !== true) input.onEffortDropped?.("Anthropic's effort has no \"none\", and thinking cannot be switched off on every adaptive model");
  } else if (effort !== undefined) {
    if (traits?.effort === true) fields.output_config = { effort: EFFORT_LEVEL[effort] };
    if (traits?.budget === true) {
      fields.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET[effort] };
      fields.max_tokens = input.maxTokens + THINKING_BUDGET[effort];
      thinking = true;
    }
    if (traits === undefined || (!traits.effort && !traits.budget)) input.onEffortDropped?.(`Anthropic documents neither effort nor a thinking budget for ${input.model}`);
  }
  if (traits?.sampling === true && !thinking) fields.temperature = input.temperature;
  return fields;
}

type Block = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: string | Block[] };

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/** Config first, then {@link ANTHROPIC_TIMEOUT_ENV}, then {@link ANTHROPIC_HEADERS_TIMEOUT_MS}. */
export function resolveAnthropicTimeoutMs(configured: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, ANTHROPIC_TIMEOUT_ENV);
  return positive(configured) ?? positive(raw === undefined ? undefined : Number(raw)) ?? ANTHROPIC_HEADERS_TIMEOUT_MS;
}

/** The key and endpoint. The key is read, never logged. */
export function resolveAnthropicRoute(env: NodeJS.ProcessEnv = process.env): { apiKey?: string; baseUrl: string } {
  const apiKey = envValue(env, "ANTHROPIC_API_KEY");
  return { ...(apiKey === undefined ? {} : { apiKey }), baseUrl: envValue(env, "ANTHROPIC_BASE_URL") ?? ANTHROPIC_BASE_URL };
}

/** Every system message, joined as the app's streamer joined them, as ONE block carrying a breakpoint. */
function systemBlocks(messages: readonly GatewayMessage[]): Block[] | undefined {
  const text = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  return text === "" ? undefined : [{ type: "text", text, cache_control: EPHEMERAL }];
}

/** `input_schema` per tool; the last one carries the breakpoint that caches the whole tools block. */
function toolBlocks(tools: readonly GatewayToolDefinition[]): Block[] {
  return tools.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(index === tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));
}

/**
 * One turn on the wire. An assistant turn the provider returned is sent back verbatim (`providerContent`); one
 * without it gets its text (never an empty text block, which the API refuses) and a `tool_use` per call.
 */
function turnOf(message: GatewayMessage): WireMessage {
  if (message.role !== "assistant") return { role: "user", content: message.content };
  if (message.providerContent !== undefined) return { role: "assistant", content: [...message.providerContent] };
  if (message.toolCalls === undefined || message.toolCalls.length === 0) return { role: "assistant", content: message.content };
  const text: Block[] = message.content === "" ? [] : [{ type: "text", text: message.content }];
  return { role: "assistant", content: [...text, ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments }))] };
}

/** The same turn with a breakpoint on its last block. */
function withBreakpoint(turn: WireMessage): WireMessage {
  const blocks: Block[] = typeof turn.content === "string" ? [{ type: "text", text: turn.content }] : turn.content;
  return { ...turn, content: [...blocks.slice(0, -1), { ...blocks[blocks.length - 1], cache_control: EPHEMERAL }] };
}

/**
 * The conversation. A user message with `toolCallId` is a `tool_result`; consecutive results form one user turn,
 * as the API expects them after the `tool_use` turn. The newest two non-empty user turns carry a breakpoint.
 */
function conversation(messages: readonly GatewayMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role !== "user" || message.toolCallId === undefined) {
      wire.push(turnOf(message));
      continue;
    }
    const result: Block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content, ...(message.isError === true ? { is_error: true } : {}) };
    const last = wire[wire.length - 1];
    if (last?.role === "user" && Array.isArray(last.content) && last.content.every((block) => block.type === "tool_result")) last.content.push(result);
    else wire.push({ role: "user", content: [result] });
  }
  const users = wire.map((turn, index) => (turn.role === "user" && turn.content.length > 0 ? index : -1)).filter((index) => index >= 0);
  for (const index of users.slice(-MESSAGE_BREAKPOINTS)) wire[index] = withBreakpoint(wire[index]!);
  return wire;
}

/**
 * How a route WITHOUT native tools reads a native conversation: role and content only (an OpenAI-compatible body
 * sends `messages` verbatim, and a strict server refuses unknown fields), each native call rendered into the
 * assistant text as `[called <name> <json>]`, and a tool result as the user text it already is.
 */
export function textOnlyMessages(messages: readonly GatewayMessage[]): GatewayMessage[] {
  return messages.map((message) => {
    const calls = (message.toolCalls ?? []).map((call) => `[called ${call.name} ${JSON.stringify(call.arguments)}]`);
    return { role: message.role, content: [message.content, ...calls].filter((part) => part !== "").join("\n") };
  });
}

/** The request body. */
export function buildAnthropicBody(input: Omit<AnthropicInput, "signal">): Record<string, unknown> {
  const system = systemBlocks(input.messages);
  return {
    model: input.model,
    ...modelFields(input),
    stream: true,
    ...(system === undefined ? {} : { system }),
    messages: conversation(input.messages),
    ...(input.tools === undefined || input.tools.length === 0 ? {} : { tools: toolBlocks(input.tools) }),
  };
}

type StreamEvent = {
  type?: unknown;
  index?: unknown;
  message?: { usage?: Record<string, unknown> };
  content_block?: Block;
  delta?: { type?: unknown; text?: unknown; partial_json?: unknown; thinking?: unknown; signature?: unknown; stop_reason?: unknown };
  usage?: Record<string, unknown>;
  error?: { type?: unknown; message?: unknown };
};

/**
 * The reply's content blocks, rebuilt from their deltas: text, `tool_use` (its `input` from the
 * `input_json_delta` fragments), and thinking with its `signature`. Kept whole because a tool-use turn must go
 * back "complete and unmodified" (https://platform.claude.com/docs/en/build-with-claude/thinking).
 */
class ContentBlocks {
  private readonly blocks: Block[] = [];
  private readonly json = new Map<number, string>();

  start(index: number, block: Block): void {
    this.blocks[index] = { ...block };
    if (block.type === "tool_use") this.json.set(index, "");
  }

  /** Applies one delta; returns the text it added to a text block, if any. */
  delta(index: number, delta: NonNullable<StreamEvent["delta"]>): string | undefined {
    const block = this.blocks[index];
    if (block === undefined) return undefined;
    const append = (field: string, piece: unknown): void => {
      if (typeof piece === "string") block[field] = `${typeof block[field] === "string" ? block[field] : ""}${piece}`;
    };
    if (delta.type === "text_delta") append("text", delta.text);
    else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") this.json.set(index, `${this.json.get(index) ?? ""}${delta.partial_json}`);
    else if (delta.type === "thinking_delta") append("thinking", delta.thinking);
    else if (delta.type === "signature_delta" && typeof delta.signature === "string") block.signature = delta.signature;
    return delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "" ? delta.text : undefined;
  }

  stop(index: number): void {
    const block = this.blocks[index];
    const json = this.json.get(index);
    if (block === undefined || json === undefined) return;
    let input: unknown;
    try {
      input = json.trim() === "" ? {} : JSON.parse(json);
    } catch {
      throw new Error(`anthropic sent tool_use input that is not JSON (${json.length} chars)`);
    }
    block.input = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
  }

  calls(): GatewayToolCall[] {
    const uses = this.content().filter((block) => block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string");
    return uses.map((block) => ({ id: String(block.id), name: String(block.name), arguments: (block.input ?? {}) as Record<string, unknown> }));
  }

  content(): ProviderContentBlock[] {
    return this.blocks.filter((block): block is Block => block !== undefined);
  }
}

interface Usage {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly thinking?: number;
}

/** `message_start` carries the input side, `message_delta` the cumulative output; a missing field keeps its value. */
function readUsage(raw: Record<string, unknown> | undefined, prior: Usage | undefined): Usage | undefined {
  if (raw === undefined) return prior;
  const input = count(raw.input_tokens) ?? prior?.input;
  if (input === undefined) return prior;
  const details = raw.output_tokens_details as Record<string, unknown> | undefined;
  const thinking = count(details?.thinking_tokens) ?? prior?.thinking;
  return {
    input,
    cacheWrite: count(raw.cache_creation_input_tokens) ?? prior?.cacheWrite ?? 0,
    cacheRead: count(raw.cache_read_input_tokens) ?? prior?.cacheRead ?? 0,
    output: count(raw.output_tokens) ?? prior?.output ?? 0,
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/**
 * The gateway's convention: `inputTokens` is the whole prompt and the cache counts are parts of it. Anthropic's
 * `input_tokens` is only the part after the last breakpoint, so the whole is the sum of the three (caching docs).
 */
function usageFrame(usage: Usage): ProviderStreamFrame {
  return {
    type: "usage",
    inputTokens: usage.input + usage.cacheWrite + usage.cacheRead,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    cacheWriteInputTokens: usage.cacheWrite,
    ...(usage.thinking === undefined ? {} : { reasoningTokens: Math.min(usage.thinking, usage.output) }),
  };
}

/**
 * An `error` event inside a 200 stream, as the HTTP status its type stands for (https://platform.claude.com/docs/en/api/errors),
 * so `retry.ts` classifies it like any other failure: 529 and 5xx are retried, 4xx are not; an unknown type is a 500.
 */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
  conflict_error: 409, request_too_large: 413, rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
};

function streamError(error: StreamEvent["error"]): ProviderHttpError {
  const type = typeof error?.type === "string" ? error.type : "api_error";
  const body = typeof error?.message === "string" ? error.message : "error inside the response stream";
  return new ProviderHttpError({ provider: "anthropic", status: ERROR_STATUS[type] ?? 500, statusText: type, body });
}

/** `max_tokens` (and the window running out) is the gateway's "length"; the turn ending is "stop"; the rest as sent. */
function finishReasonOf(stopReason: string): string {
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") return "length";
  if (stopReason === "end_turn" || stopReason === "stop_sequence") return "stop";
  return stopReason;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/** The SSE body, one line at a time. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  yield buffer.replace(/\r$/, "");
}

/**
 * Streams one Messages API call. Tokens as they arrive; the finish (with any native calls) and ONE usage frame
 * at the end. The run's AbortSignal aborts the fetch and the body read, so a cancelled run closes its socket
 * at once, and a consumer that stops early (a `return()` from the gateway) closes it too.
 */
export async function* streamAnthropicMessages(input: AnthropicInput, route: AnthropicRoute): AsyncGenerator<ProviderStreamFrame> {
  const controller = new AbortController();
  const signal = input.signal;
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let finished = false;
  const headersMs = route.headersTimeoutMs ?? ANTHROPIC_HEADERS_TIMEOUT_MS;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    controller.abort();
  }, headersMs);
  try {
    const fetchImpl = route.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    const headers = { "x-api-key": route.apiKey, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" };
    let response: Response;
    try {
      response = await fetchImpl(`${route.baseUrl.replace(/\/+$/, "")}/v1/messages`, { method: "POST", headers, body: JSON.stringify(buildAnthropicBody(input)), signal: controller.signal });
    } catch (error) {
      if (!expired) throw error;
      const timeout = new Error(`anthropic sent no response headers within ${headersMs} ms (${ANTHROPIC_TIMEOUT_ENV})`);
      timeout.name = "TimeoutError"; // classified as a timeout, retried once (retry.ts)
      throw timeout;
    }
    clearTimeout(deadline);
    if (!response.ok) {
      throw new ProviderHttpError({ provider: "anthropic", status: response.status, statusText: response.statusText, headers: response.headers, body: await response.text().catch(() => "") });
    }
    if (response.body === null) throw new Error("anthropic returned no response body");
    let usage: Usage | undefined;
    let stopReason: string | undefined;
    const blocks = new ContentBlocks();
    for await (const line of sseLines(response.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "") continue;
      let event: StreamEvent;
      try {
        event = JSON.parse(payload) as StreamEvent;
      } catch {
        throw new Error(`anthropic sent an unreadable stream event (${payload.length} chars)`);
      }
      const index = count(event.index);
      if (event.type === "error") throw streamError(event.error);
      if (event.type === "message_start") usage = readUsage(event.message?.usage, usage);
      else if (event.type === "content_block_start" && index !== undefined && event.content_block) blocks.start(index, event.content_block);
      else if (event.type === "content_block_delta" && index !== undefined && event.delta) {
        const text = blocks.delta(index, event.delta);
        if (text !== undefined) yield { type: "token", content: text };
      } else if (event.type === "content_block_stop" && index !== undefined) blocks.stop(index);
      else if (event.type === "message_delta") {
        usage = readUsage(event.usage, usage);
        if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
      }
    }
    finished = true;
    const toolCalls = blocks.calls();
    const calls = toolCalls.length === 0 ? {} : { toolCalls, providerContent: blocks.content() };
    if (stopReason !== undefined || toolCalls.length > 0) yield { type: "finish", reason: finishReasonOf(stopReason ?? "tool_use"), ...calls };
    if (usage !== undefined) yield usageFrame(usage);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", onAbort);
    // A consumer that stopped early (cancellation, a failed attempt) closes the socket.
    if (!finished) controller.abort();
  }
}

export interface AnthropicRouteDeps {
  readonly fetchImpl?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  /** Config `anthropicTimeoutMs`; absent, the env bridge, then the default. */
  readonly timeoutMs?: number;
  /** The gateway's once-per-instance `model_gateway.reasoning_effort_not_sent` line. */
  readonly onEffortDropped?: (fields: { provider: string; model: string; reason: string }) => void;
}

/** One attempt on the `anthropic` route. */
export async function* streamAnthropicRoute(model: string, input: Omit<AnthropicInput, "model" | "onEffortDropped">, deps: AnthropicRouteDeps = {}): AsyncGenerator<ProviderStreamFrame> {
  const env = deps.env ?? process.env;
  const route = resolveAnthropicRoute(env);
  if (route.apiKey === undefined) throw new Error("ANTHROPIC_API_KEY is not configured");
  const onEffortDropped = (reason: string): void => deps.onEffortDropped?.({ provider: "anthropic", model, reason });
  const headersTimeoutMs = resolveAnthropicTimeoutMs(deps.timeoutMs, env);
  yield* streamAnthropicMessages({ ...input, model, onEffortDropped }, { apiKey: route.apiKey, baseUrl: route.baseUrl, headersTimeoutMs, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
}

/**
 * `ModelGateway.complete()`: `collect` (`complete.ts`) plus the fields it does not read (the finish event's calls,
 * the usage event's cache writes). Here only because `complete.ts` was outside this change.
 */
export async function collectWithNativeFields(
  events: AsyncIterable<GatewayStreamEvent>,
  collect: (events: AsyncIterable<GatewayStreamEvent>) => Promise<GatewayCompletion>,
): Promise<GatewayCompletion> {
  const extra: Pick<GatewayCompletion, "toolCalls" | "providerContent" | "cacheWriteInputTokens"> = {};
  async function* tapped(): AsyncGenerator<GatewayStreamEvent> {
    for await (const event of events) {
      if (event.type === "finish" && event.toolCalls !== undefined) Object.assign(extra, { toolCalls: event.toolCalls }, event.providerContent ? { providerContent: event.providerContent } : {});
      if (event.type === "usage" && event.cacheWriteInputTokens !== undefined) extra.cacheWriteInputTokens = event.cacheWriteInputTokens;
      yield event;
    }
  }
  return { ...(await collect(tapped())), ...extra };
}
