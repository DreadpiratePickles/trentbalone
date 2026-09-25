/**
 * [P1-C] The Trent-side streamer for Google's OpenAI-compatible endpoint.
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
 * The request mirrors what the app sent for a Gemini model (`modelChatTuning`: `max_tokens` and
 * `temperature`), the key and base URL are resolved from the same variables the app reads
 * (`GOOGLE_API_KEY` then `GEMINI_API_KEY`, `GOOGLE_BASE_URL`), and a non-2xx is the same
 * `ProviderHttpError` the retry policy already classifies. The other providers keep the app's path.
 */

import { ProviderHttpError } from "./retry.js";
import type { ReasoningEffort } from "./call-policy.js";
import type { GatewayMessage, ProviderStreamFrame } from "./types.js";

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
}

export interface CompatRoute {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly headersTimeoutMs?: number;
}

/** The request body. `reasoning_effort` is present only when configured. */
export function buildCompatChatBody(input: Omit<CompatChatInput, "signal">): Record<string, unknown> {
  return {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: input.messages,
    max_tokens: input.maxTokens,
    temperature: input.temperature,
    ...(input.reasoningEffort === undefined ? {} : { reasoning_effort: input.reasoningEffort }),
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

/** Fetch with a deadline on the HEADERS only; the run's signal aborts the whole exchange. */
async function openStream(url: string, init: RequestInit, route: CompatRoute, signal: AbortSignal | undefined): Promise<{ response: Response; controller: AbortController; detach: () => void }> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const detach = (): void => signal?.removeEventListener("abort", onAbort);
  const timeoutMs = route.headersTimeoutMs ?? COMPAT_HEADERS_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await (route.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i)))(url, { ...init, signal: controller.signal });
    return { response, controller, detach };
  } catch (error) {
    detach();
    if (!timedOut) throw error;
    const timeout = new Error(`google request sent no response headers within ${timeoutMs}ms`);
    timeout.name = "TimeoutError"; // classifies as a retryable timeout (retry.ts)
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
}

type ChunkChoice = { delta?: { content?: unknown }; finish_reason?: unknown };
type Chunk = { choices?: ChunkChoice[]; usage?: unknown; error?: { code?: unknown; message?: unknown } };

function streamError(error: NonNullable<Chunk["error"]>): ProviderHttpError {
  const code = typeof error.code === "number" && error.code >= 400 && error.code <= 599 ? error.code : 502;
  const message = typeof error.message === "string" ? error.message : "error inside the response stream";
  return new ProviderHttpError({ provider: "google", status: code, statusText: "stream error", body: message });
}

function* framesOf(chunk: Chunk): Generator<ProviderStreamFrame> {
  if (chunk.error) throw streamError(chunk.error);
  const choice = chunk.choices?.[0];
  const token = choice?.delta?.content;
  if (typeof token === "string" && token !== "") yield { type: "token", content: token };
  if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") yield { type: "finish", reason: choice.finish_reason };
}

/**
 * Streams one chat completion. Tokens and the finish reason are yielded as they arrive; the usage
 * frame is yielded ONCE, after the stream ends, from the last usage object Google sent (it sends
 * the same one twice).
 */
export async function* streamGoogleCompatChat(input: CompatChatInput, route: CompatRoute): AsyncGenerator<ProviderStreamFrame> {
  const body = buildCompatChatBody(input);
  const { response, controller, detach } = await openStream(
    chatUrl(route.baseUrl),
    { method: "POST", headers: { authorization: `Bearer ${route.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    route,
    input.signal,
  );
  let finished = false;
  try {
    if (!response.ok) {
      throw new ProviderHttpError({ provider: "google", status: response.status, statusText: response.statusText, headers: response.headers, body: await response.text().catch(() => "") });
    }
    if (response.body === null) throw new Error("google returned no response body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: CompatUsage | undefined;
    const handle = function* (line: string): Generator<ProviderStreamFrame> {
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") return;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload) as Chunk;
      } catch {
        throw new Error(`google sent an unreadable stream chunk (${payload.length} chars)`);
      }
      usage = parseCompatUsage(chunk.usage) ?? usage;
      yield* framesOf(chunk);
    };
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield* handle(line);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    yield* handle(buffer.replace(/\r$/, ""));
    finished = true;
    if (usage !== undefined) yield { type: "usage", ...usage };
  } finally {
    detach();
    // A consumer that stopped early (cancellation, a failed attempt) closes the socket.
    if (!finished) controller.abort();
  }
}
