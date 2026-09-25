/**
 * [P1-C] The Trent-side OpenAI-compatible streamer for `google`. RED first: `apps/web`'s streamer
 * (read-only) asks Google for no usage frame, reads no `prompt_tokens_details` and cannot carry
 * `reasoning_effort`, so all three facts below were false before this file's module existed.
 * Offline: every response is a fixture handed to an injected `fetch`.
 */
import { describe, expect, it } from "vitest";

import { buildCompatChatBody, parseCompatUsage, streamGoogleCompatChat } from "./openai-compat.js";
import { ProviderHttpError } from "./retry.js";
import type { ProviderStreamFrame } from "./types.js";

const MESSAGES = [
  { role: "system" as const, content: "stable prefix" },
  { role: "user" as const, content: "question" },
];

function sse(chunks: readonly unknown[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A fetch that records the request and answers with `body`, split at awkward byte boundaries. */
function fakeFetch(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string | URL | Request, request?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(request?.headers).entries()),
      body: JSON.parse(String(request?.body)) as Record<string, unknown>,
    });
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    });
    return new Response(stream, { status: init.status ?? 200, headers: init.headers ?? { "content-type": "text/event-stream" } });
  };
  return { fetchImpl, calls };
}

async function collect(gen: AsyncGenerator<ProviderStreamFrame>): Promise<ProviderStreamFrame[]> {
  const out: ProviderStreamFrame[] = [];
  for await (const frame of gen) out.push(frame);
  return out;
}

describe("buildCompatChatBody", () => {
  it("the body carries reasoning_effort when configured and omits it otherwise", () => {
    const withEffort = buildCompatChatBody({ model: "gemini-3.5-flash-lite", messages: MESSAGES, temperature: 0.2, maxTokens: 512, reasoningEffort: "low" });
    expect(withEffort.reasoning_effort).toBe("low");

    const without = buildCompatChatBody({ model: "gemini-3.5-flash-lite", messages: MESSAGES, temperature: 0.2, maxTokens: 512 });
    expect("reasoning_effort" in without).toBe(false);
  });

  it("always asks for the usage frame, which Google sends on a stream only when asked", () => {
    const body = buildCompatChatBody({ model: "gemini-3.5-flash-lite", messages: MESSAGES, temperature: 0, maxTokens: 64 });
    expect(body).toMatchObject({ model: "gemini-3.5-flash-lite", stream: true, stream_options: { include_usage: true }, max_tokens: 64, temperature: 0 });
    expect(body.messages).toEqual(MESSAGES);
  });
});

describe("parseCompatUsage", () => {
  it("reads prompt_tokens_details.cached_tokens", () => {
    expect(parseCompatUsage({ prompt_tokens: 11_018, completion_tokens: 2, total_tokens: 11_020, prompt_tokens_details: { cached_tokens: 8_165 } })).toEqual({
      inputTokens: 11_018,
      outputTokens: 2,
      cachedInputTokens: 8_165,
      reasoningTokens: 0,
    });
  });

  it("no cached_tokens field means zero cached tokens", () => {
    expect(parseCompatUsage({ prompt_tokens: 16, completion_tokens: 3, total_tokens: 19 })).toMatchObject({ inputTokens: 16, cachedInputTokens: 0 });
  });

  it("bills Gemini's thinking tokens as output: they are in total_tokens and not in completion_tokens", () => {
    // Measured live 2026-09-25 on gemini-3.5-flash-lite with reasoning_effort "high".
    expect(parseCompatUsage({ prompt_tokens: 16, completion_tokens: 3, total_tokens: 254 })).toEqual({
      inputTokens: 16,
      outputTokens: 238,
      cachedInputTokens: 0,
      reasoningTokens: 235,
    });
  });

  it("never lets a cached count exceed the prompt, and rejects a usage object it cannot read", () => {
    expect(parseCompatUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } })?.cachedInputTokens).toBe(10);
    expect(parseCompatUsage(undefined)).toBeUndefined();
    expect(parseCompatUsage({ prompt_tokens: "ten" })).toBeUndefined();
  });
});

describe("streamGoogleCompatChat", () => {
  const route = { apiKey: "test-google-key", baseUrl: "https://example.test/v1beta/openai/" };

  it("streams tokens, the finish reason and ONE usage frame carrying the cached tokens", async () => {
    const usage = { prompt_tokens: 11_018, completion_tokens: 2, total_tokens: 11_020, prompt_tokens_details: { cached_tokens: 8_165 } };
    const { fetchImpl, calls } = fakeFetch(sse([
      { choices: [{ delta: { content: "R", role: "assistant" }, index: 0 }] },
      { choices: [{ delta: { content: "5" }, index: 0, finish_reason: "stop" }], usage },
      { choices: [], usage },
    ]));

    const frames = await collect(streamGoogleCompatChat(
      { model: "gemini-3.6-flash", messages: MESSAGES, temperature: 0, maxTokens: 64, reasoningEffort: "high" },
      { ...route, fetchImpl },
    ));

    expect(frames.filter((f) => f.type === "token").map((f) => (f.type === "token" ? f.content : ""))).toEqual(["R", "5"]);
    expect(frames).toContainEqual({ type: "finish", reason: "stop" });
    const usages = frames.filter((f) => f.type === "usage");
    expect(usages).toEqual([{ type: "usage", inputTokens: 11_018, outputTokens: 2, cachedInputTokens: 8_165, reasoningTokens: 0 }]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.test/v1beta/openai/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-google-key");
    expect(calls[0]!.body.reasoning_effort).toBe("high");
  });

  it("a non-2xx is the provider's own ProviderHttpError, with the status and Retry-After the retry policy reads", async () => {
    const { fetchImpl } = fakeFetch(JSON.stringify({ error: { message: "quota" } }), { status: 429, headers: { "retry-after": "3" } });
    const failure = await collect(streamGoogleCompatChat({ model: "m", messages: MESSAGES, temperature: 0, maxTokens: 8 }, { ...route, fetchImpl })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect((failure as ProviderHttpError).status).toBe(429);
    expect((failure as ProviderHttpError).message).not.toContain("test-google-key");
  });

  it("an error object inside the stream fails the attempt instead of ending it as a quiet success", async () => {
    const { fetchImpl } = fakeFetch(sse([{ error: { code: 503, message: "overloaded" } }]));
    await expect(collect(streamGoogleCompatChat({ model: "m", messages: MESSAGES, temperature: 0, maxTokens: 8 }, { ...route, fetchImpl }))).rejects.toThrow(/503|overloaded/);
  });
});
