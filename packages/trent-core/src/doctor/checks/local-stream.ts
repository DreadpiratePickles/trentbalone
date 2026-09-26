/**
 * The doctor's transport to a local runtime's OpenAI-compatible `/chat/completions`, through the
 * doctor's fetch seam, so every Local Model test runs against a fake runtime and never a socket.
 *
 * The request body is the gateway's own (`buildCompatChatBody`: streamed, `include_usage`,
 * `max_tokens`, `reasoning_effort` when configured) and usage is read by the gateway's own parser
 * (`parseCompatUsage`). The bearer is the non-secret placeholder the alias bridge sends to a local
 * runtime (`LOCAL_PLACEHOLDER_KEY`), never an operator key.
 */
import { buildCompatChatBody, parseCompatUsage, type CompatUsage } from "../../model-gateway/openai-compat.js";
import { LOCAL_PLACEHOLDER_KEY } from "../../model-gateway/providers.js";
import type { ReasoningEffort } from "../../model-gateway/call-policy.js";
import type { GatewayMessage, ProviderStreamFn } from "../../model-gateway/types.js";
import type { FetchLike } from "../types.js";

export interface LocalChatRoute {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
}

export interface LocalChatRequest {
  readonly model: string;
  readonly messages: readonly GatewayMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
}

type Delta = { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
type ChatChunk = { choices?: { delta?: Delta; finish_reason?: unknown }[]; usage?: unknown; error?: { message?: unknown } | string };

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** Link an outer signal to a controller of our own, so our deadline and the caller's both abort. */
function linkedController(outer?: AbortSignal): { controller: AbortController; detach: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", abort, { once: true });
  return { controller, detach: () => outer?.removeEventListener("abort", abort) };
}

async function openChat(route: LocalChatRoute, request: LocalChatRequest, signal: AbortSignal): Promise<Response> {
  const body = buildCompatChatBody({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
  });
  const doFetch = route.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const url = chatUrl(route.baseUrl);
  const response = await doFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${LOCAL_PLACEHOLDER_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    // The runtime's own error text (e.g. `model "x" not found`) is what the operator needs.
    const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`HTTP ${response.status} from ${url}${text ? `: ${text}` : ""}`);
  }
  if (response.body === null) throw new Error(`${url} returned no response body`);
  return response;
}

/** Every `data:` chunk of an SSE body, parsed. `[DONE]` and blank lines are skipped. */
async function* chunksOf(response: Response): AsyncGenerator<ChatChunk> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (line: string): ChatChunk | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return undefined;
    try {
      return JSON.parse(payload) as ChatChunk;
    } catch {
      throw new Error(`the runtime sent an unreadable stream chunk (${payload.length} chars)`);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const chunk = parse(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      if (chunk !== undefined) yield chunk;
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const last = parse(buffer.replace(/\r$/, ""));
  if (last !== undefined) yield last;
}

function streamError(chunk: ChatChunk): Error | undefined {
  if (chunk.error === undefined) return undefined;
  const message = typeof chunk.error === "string" ? chunk.error : typeof chunk.error.message === "string" ? chunk.error.message : "error inside the response stream";
  return new Error(`the runtime reported an error mid-stream: ${message}`);
}

function nonEmpty(value: unknown): boolean {
  return (typeof value === "string" && value !== "") || (Array.isArray(value) && value.length > 0);
}

/** Any generated token: answer text, a thinking model's reasoning, or a native tool call. */
function carriesToken(chunk: ChatChunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  return delta !== undefined && (nonEmpty(delta.content) || nonEmpty(delta.reasoning) || nonEmpty(delta.reasoning_content) || nonEmpty(delta.tool_calls));
}

/**
 * The gateway's `streamProvider` for the doctor: the model gateway runs its own redaction, retry
 * policy, pricing and completion collection around this, exactly as for a seat call; only the
 * wire is the doctor's. Reasoning text is not answer text and is not yielded, as the app's
 * streamer does not yield it either.
 */
export function localStreamProvider(route: LocalChatRoute): ProviderStreamFn {
  return async function* (_provider, model, input) {
    const { controller, detach } = linkedController(input.signal);
    let finished = false;
    try {
      const response = await openChat(route, {
        model,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      }, controller.signal);
      let usage: CompatUsage | undefined;
      for await (const chunk of chunksOf(response)) {
        const error = streamError(chunk);
        if (error) throw error;
        usage = parseCompatUsage(chunk.usage) ?? usage;
        const choice = chunk.choices?.[0];
        const token = choice?.delta?.content;
        if (typeof token === "string" && token !== "") yield { type: "token", content: token };
        if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") yield { type: "finish", reason: choice.finish_reason };
      }
      finished = true;
      if (usage !== undefined) yield { type: "usage", ...usage };
    } finally {
      detach();
      if (!finished) controller.abort();
    }
  };
}

export interface FirstTokenReading {
  /** Milliseconds from sending the request to the first generated token. */
  readonly ms?: number;
  readonly timedOut: boolean;
  /** `usage.prompt_tokens` as the runtime counted it, when it reported usage. */
  readonly promptTokens?: number;
  readonly error?: string;
}

/**
 * Time to first token for one streamed request. The deadline aborts the request; a first token
 * that arrived before it is kept, and the rest of the stream is read only for the usage frame.
 */
export async function measureFirstToken(
  route: LocalChatRoute,
  request: LocalChatRequest,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): Promise<FirstTokenReading> {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  const started = now();
  let first: number | undefined;
  let promptTokens: number | undefined;
  try {
    const response = await openChat(route, request, controller.signal);
    for await (const chunk of chunksOf(response)) {
      const error = streamError(chunk);
      if (error) throw error;
      if (first === undefined && carriesToken(chunk)) first = now() - started;
      promptTokens = parseCompatUsage(chunk.usage)?.inputTokens ?? promptTokens;
    }
    if (first === undefined) first = now() - started; // an empty answer still ended the prefill
  } catch (error) {
    if (first === undefined) {
      return expired
        ? { timedOut: true }
        : { timedOut: false, error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    clearTimeout(timer);
  }
  return { ms: first, timedOut: false, ...(promptTokens === undefined ? {} : { promptTokens }) };
}
