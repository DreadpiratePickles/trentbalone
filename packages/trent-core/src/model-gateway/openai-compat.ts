/**
 * [P1-C] The Trent-side streamer for OpenAI-compatible endpoints; [L0-2] now for every one of them.
 *
 * Why it exists. Every Google call used to go through `apps/web/lib/ai-client.ts`
 * `streamOpenAiCompatibleChat`, which is read-only and wrong for Google in three measured ways
 * (live probes, docs/sessions/2026-09-25-p1c-model-cost.md):
 *   1. it sends `stream_options.include_usage` for `openai` only, and Google's stream carries NO
 *      usage frame unless asked, so every Google call was billed on the chars/4 estimate;
 *   2. it reads `prompt_tokens` and `completion_tokens` only, so `prompt_tokens_details.cached_tokens`
 *      (the implicit-cache hits Google bills at a tenth of the input rate) never reached the meter;
 *   3. it has no way to send `reasoning_effort`.
 * One more fact the probes found: Google's `completion_tokens` EXCLUDES thinking tokens. They are in
 * `total_tokens` only (16 prompt + 3 completion, total 254 at `reasoning_effort: high`), and Google
 * bills them as output, so `parseCompatUsage` folds the difference into the billed output count.
 *
 * [L0-2] `openai` itself and the four aliases resolved to it (`ollama`, `lmstudio`, `deepseek`,
 * `groq`) stream here too (`openai-route.ts`). The app's client gave them a 60 s timeout that killed
 * a 27B model's planner during prefill (audit G2), the SDK's own two retries on top of the gateway's
 * three, and no cached-token count. A LOCAL route (`route.local`) has two budgets instead of the
 * headers one: time to the first token, then the longest silence between tokens (`local-runtime.ts`).
 * A hosted route keeps the 60 s the app's client allowed for response headers.
 *
 * A non-2xx is the same `ProviderHttpError` the retry policy already classifies; a budget that runs
 * out is a `TimeoutError` (retried once, `retry.ts`) whose message names the budget and its setting.
 */

import { ProviderHttpError } from "./retry.js";
import type { ReasoningEffort } from "./call-policy.js";
import { LOCAL_MODEL_SETTINGS } from "./local-runtime.js";
import type { GatewayMessage, GatewayResponseFormat, ProviderStreamFrame } from "./types.js"; // [L1] GatewayResponseFormat

export const GOOGLE_COMPAT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

/** Time allowed for the response headers, as the app's SDK client allowed (`timeout: 60_000`). */
export const COMPAT_HEADERS_TIMEOUT_MS = 60_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CompatChatInput {
  readonly model: string;
  readonly messages: readonly GatewayMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
  /** [L0-2] Replaces `max_tokens` and `temperature`: the app's `modelChatTuning` for this model. */
  readonly tuning?: Readonly<Record<string, unknown>>;
  /** [L1] Already decided for this route (`response-format.ts`); sent verbatim as `response_format`. */
  readonly responseFormat?: GatewayResponseFormat;
}

/** [L0-2] The two budgets of a model on the operator's own machine. */
export interface LocalBudgets {
  readonly ttftMs: number;
  readonly idleMs: number;
}

export interface CompatRoute {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly headersTimeoutMs?: number;
  /** [L0-2] The provider named in errors: `google`, `openai`, or the alias (`ollama`, ...). */
  readonly label?: string;
  /** [L0-2] Extra request headers (OpenAI's organization and project). Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  /** [L0-2] Present for a local runtime: its budgets replace the headers budget. */
  readonly local?: LocalBudgets;
}

/** The request body. `reasoning_effort` is present only when configured. */
export function buildCompatChatBody(input: Omit<CompatChatInput, "signal">): Record<string, unknown> {
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: input.messages,
    ...(input.tuning ?? { max_tokens: input.maxTokens, temperature: input.temperature }),
    ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
    ...(input.responseFormat === undefined ? {} : { response_format: input.responseFormat }), // [L1]
  };
}

export interface CompatUsage {
  readonly inputTokens: number;
  /** BILLED output: `completion_tokens` plus any thinking tokens only `total_tokens` shows. */
  readonly outputTokens: number;
  /** `prompt_tokens_details.cached_tokens`, never more than the prompt; 0 when absent. */
  readonly cachedInputTokens: number;
  /** The thinking tokens inside `outputTokens`. */
  readonly reasoningTokens: number;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/** A usage object, or undefined when it is not one (never a guessed zero dressed up as usage). */
export function parseCompatUsage(usage: unknown): CompatUsage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const raw = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  const prompt = count(raw.prompt_tokens);
  const completion = count(raw.completion_tokens);
  if (prompt === undefined || completion === undefined) return undefined;
  const total = count(raw.total_tokens);
  const reasoningTokens = total !== undefined && total > prompt + completion ? total - prompt - completion : 0;
  const cached = count(raw.prompt_tokens_details?.cached_tokens) ?? 0;
  return { inputTokens: prompt, outputTokens: completion + reasoningTokens, cachedInputTokens: Math.min(cached, prompt), reasoningTokens };
}

/** The key and base URL the app's own Google client would use. The key is read, never logged. */
export function googleCompatRoute(env: NodeJS.ProcessEnv = process.env): { apiKey?: string; baseUrl: string } {
  const apiKey = env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY;
  return { ...(apiKey ? { apiKey } : {}), baseUrl: env.GOOGLE_BASE_URL ?? GOOGLE_COMPAT_BASE_URL };
}

function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError"; // classifies as a timeout, retried once (retry.ts)
  return error;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** [L0-2] One timer, re-armed as the exchange moves from waiting to streaming. */
class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  expired: string | undefined;

  constructor(private readonly controller: AbortController) {}

  arm(ms: number, message: string): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.expired = message;
      this.controller.abort();
    }, ms);
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The error to throw for a failure that happened because this deadline fired. */
  explain(error: unknown): unknown {
    return this.expired === undefined ? error : timeoutError(this.expired);
  }
}

function budgetMessages(label: string, local: LocalBudgets): { ttft: string; idle: string } {
  return {
    ttft:
      `${label} sent no token within the ${seconds(local.ttftMs)} time-to-first-token budget (${LOCAL_MODEL_SETTINGS.ttftSeconds}); ` +
      "prefill of a long prompt on a large local model can take longer: raise it, shorten the prompt, or use a smaller model",
    idle: `${label} went silent for ${seconds(local.idleMs)} after its first token, past the idle budget (${LOCAL_MODEL_SETTINGS.idleSeconds})`,
  };
}

type Delta = { content?: unknown; reasoning?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
type ChunkChoice = { delta?: Delta; finish_reason?: unknown };
type Chunk = { choices?: ChunkChoice[]; usage?: unknown; timings?: { cache_n?: unknown }; error?: { code?: unknown; message?: unknown } };

function streamError(label: string, error: NonNullable<Chunk["error"]>): ProviderHttpError {
  const code = typeof error.code === "number" && error.code >= 400 && error.code <= 599 ? error.code : 502;
  const message = typeof error.message === "string" ? error.message : "error inside the response stream";
  return new ProviderHttpError({ provider: label, status: code, statusText: "stream error", body: message });
}

function* framesOf(label: string, chunk: Chunk): Generator<ProviderStreamFrame> {
  if (chunk.error) throw streamError(label, chunk.error);
  const choice = chunk.choices?.[0];
  const token = choice?.delta?.content;
  if (typeof token === "string" && token !== "") yield { type: "token", content: token };
  if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") yield { type: "finish", reason: choice.finish_reason };
}

/** [L0-2] The model is generating: text, thinking (Ollama `reasoning`, llama.cpp `reasoning_content`) or a tool call. */
function carriesToken(chunk: Chunk): boolean {
  const delta = chunk.choices?.[0]?.delta;
  const said = (value: unknown): boolean => typeof value === "string" && value !== "";
  return delta !== undefined && (said(delta.content) || said(delta.reasoning) || said(delta.reasoning_content) || delta.tool_calls !== undefined);
}

/**
 * Streams one chat completion. Tokens and the finish reason are yielded as they arrive; the usage
 * frame is yielded ONCE, after the stream ends, from the last usage object the server sent (Google
 * sends the same one twice). llama.cpp's `timings.cache_n` stands in for a missing cached count.
 */
export async function* streamCompatChat(input: CompatChatInput, route: CompatRoute): AsyncGenerator<ProviderStreamFrame> {
  const label = route.label ?? "google";
  const controller = new AbortController();
  const signal = input.signal;
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadline = new Deadline(controller);
  const budgets = route.local === undefined ? undefined : budgetMessages(label, route.local);
  if (route.local !== undefined && budgets !== undefined) deadline.arm(route.local.ttftMs, budgets.ttft);
  else {
    const headersMs = route.headersTimeoutMs ?? COMPAT_HEADERS_TIMEOUT_MS;
    deadline.arm(headersMs, `${label} request sent no response headers within ${headersMs}ms`);
  }
  let finished = false;
  try {
    const fetchImpl = route.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
    const headers = { ...route.headers, authorization: `Bearer ${route.apiKey}`, "content-type": "application/json" };
    let response: Response;
    try {
      response = await fetchImpl(chatUrl(route.baseUrl), { method: "POST", headers, body: JSON.stringify(buildCompatChatBody(input)), signal: controller.signal });
    } catch (error) {
      throw deadline.explain(error);
    }
    if (route.local === undefined) deadline.clear(); // a hosted route's budget covers the headers only
    if (!response.ok) {
      throw new ProviderHttpError({ provider: label, status: response.status, statusText: response.statusText, headers: response.headers, body: await response.text().catch(() => "") });
    }
    if (response.body === null) throw new Error(`${label} returned no response body`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: CompatUsage | undefined;
    let cacheN: number | undefined;
    let generating = false;
    const handle = function* (line: string): Generator<ProviderStreamFrame> {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload) as Chunk;
      } catch {
        throw new Error(`${label} sent an unreadable stream chunk (${payload.length} chars)`);
      }
      usage = parseCompatUsage(chunk.usage) ?? usage;
      cacheN = count(chunk.timings?.cache_n) ?? cacheN;
      if (carriesToken(chunk)) generating = true;
      yield* framesOf(label, chunk);
    };
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (error) {
        throw deadline.explain(error);
      }
      const { done, value } = read;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield* handle(line);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
      // [L0-2] After the first token, every byte the server sends resets the idle budget.
      if (route.local !== undefined && budgets !== undefined && generating) deadline.arm(route.local.idleMs, budgets.idle);
    }
    yield* handle(buffer.replace(/\r$/, ""));
    finished = true;
    if (usage !== undefined) {
      const cached = usage.cachedInputTokens === 0 && cacheN !== undefined ? Math.min(cacheN, usage.inputTokens) : usage.cachedInputTokens;
      yield { type: "usage", ...usage, cachedInputTokens: cached };
    }
  } finally {
    deadline.clear();
    signal?.removeEventListener("abort", onAbort);
    // A consumer that stopped early (cancellation, a failed attempt) closes the socket.
    if (!finished) controller.abort();
  }
}

/** [P1-C] The Google route, unchanged in behaviour: its errors say `google`. */
export function streamGoogleCompatChat(input: CompatChatInput, route: CompatRoute): AsyncGenerator<ProviderStreamFrame> {
  return streamCompatChat(input, { label: "google", ...route });
}
