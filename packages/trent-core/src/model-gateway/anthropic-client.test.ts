/**
 * [C14] RED first: `anthropic` streamed through the app's `streamAnthropicMessages` (read-only), which sends
 * `system` as a plain string, no `tools`, no `cache_control`, reads `input_tokens` only, takes no AbortSignal
 * and has no timeout of its own. Every test here goes through `createModelGateway` to a FAKE Anthropic
 * Messages endpoint on loopback (node:http, 127.0.0.1, an ephemeral port).
 *
 * No test can make a live call: `fetch` is replaced by a guard that forwards loopback requests and REFUSES
 * any other host, recording the body it refused. That is also how the red is read: before C14 the app's
 * streamer posted to its hardcoded `api.anthropic.com`, the guard refused it, and the assertions below
 * report what that body lacked. No key here is real.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEB_TOOL_SCHEMAS } from "../tools/web/schemas.js";
import { ANTHROPIC_HEADERS_TIMEOUT_MS, resolveAnthropicTimeoutMs } from "./anthropic-client.js";
import { createModelGateway } from "./index.js";
import { ALIAS_ENV } from "./providers.js";
import type { GatewayMessage } from "./types.js";

const TEST_KEY = "test-anthropic-key";
const ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "TRENT_ANTHROPIC_TIMEOUT_MS", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS",
  "WORKBENCH_EXECUTOR_MODEL", "WORKBENCH_PLANNER_MODEL", "TRENT_REASONING_EFFORT", "TRENT_MODEL_FALLBACK_ON_PIN", ALIAS_ENV,
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL",
];
const saved = new Map<string, string | undefined>();

interface Seen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

/** What the guard refused: a request for a host that is not loopback. */
const refused: Array<{ readonly url: string; readonly body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
const servers: http.Server[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  refused.length = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") {
      refused.push({ url: url.href, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      throw new Error(`test guard: refused a request to ${url.host}; only loopback is allowed here`);
    }
    return realFetch(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections(); // a held-open stream must not keep the suite waiting
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

/** One SSE frame per event, as the Messages API streams them. */
function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

type Usage = { input_tokens: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

/** A whole reply: `message_start`, the given content blocks as start/delta/stop, `message_delta`, `message_stop`. */
function reply(blocks: readonly Record<string, unknown>[], usage: Usage, stopReason = "end_turn", outputTokens = 2): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, usage: { output_tokens: 1, ...usage } } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const piece of String(block.text).match(/.{1,3}/g) ?? []) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: piece } });
    } else if (block.type === "tool_use") {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      const json = JSON.stringify(block.input);
      for (let at = 0; at < json.length; at += 5) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + 5) } });
    } else if (block.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
  events.push({ type: "message_stop" });
  return sse(events);
}

const READY = reply([{ type: "text", text: "ready" }], { input_tokens: 12 });

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void;

/** A fake Messages API on loopback. `answer` gets each request after its body is read; the default streams READY. */
async function fakeAnthropic(answer?: Handler): Promise<{ readonly seen: Seen[]; readonly url: string }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const entry = { url: req.url ?? "", headers: req.headers, body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>) };
      seen.push(entry);
      if (answer) return answer(req, res, entry);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(READY);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_BASE_URL = url;
  return { seen, url };
}

/** The body Anthropic would have received: the fake server's, else the one the guard refused (the red case). */
function sentBody(seen: readonly Seen[]): Record<string, unknown> {
  return seen[0]?.body ?? refused[0]?.body ?? {};
}

async function anthropicGateway(extra: Record<string, unknown> = {}) {
  return createModelGateway({
    apiKeys: { anthropic: TEST_KEY },
    preferredProvider: "anthropic",
    allowedProviders: ["anthropic"],
    models: { executor: "claude-opus-5-5" },
    retry: { attempts: 1 },
    retryLog: () => undefined,
    redactionLog: () => undefined,
    ...extra,
  });
}

/** A solo turn's shape: the stable system prefix, an earlier exchange, then this turn's objective. */
const SYSTEM = `You are Trent. ${"The tool protocol and the persona stay the same on every turn. ".repeat(40)}`;
const SOLO_MESSAGES: GatewayMessage[] = [
  { role: "system", content: SYSTEM },
  { role: "user", content: "Find the opening hours of the York shop." },
  { role: "assistant", content: "They open at nine." },
  { role: "user", content: "And on Sunday?" },
];
const EPHEMERAL = { type: "ephemeral" };

describe("[C14] a solo-shaped request reaches Anthropic with native tools and cache breakpoints", () => {
  it("carries `tools` (input_schema per tool) and cache_control on the system block, the tools block and the last two user turns", async () => {
    const { seen } = await fakeAnthropic();
    const gateway = await anthropicGateway();

    const completion = await gateway.complete({ messages: SOLO_MESSAGES, tools: WEB_TOOL_SCHEMAS, model: "claude-opus-5-5", maxTokens: 1024 }).catch((error: unknown) => error);

    const body = sentBody(seen);
    expect(body.tools, "no `tools` on the request").toEqual([
      { name: "web_search", description: WEB_TOOL_SCHEMAS[0]!.description, input_schema: WEB_TOOL_SCHEMAS[0]!.parameters },
      { name: "web_extract", description: WEB_TOOL_SCHEMAS[1]!.description, input_schema: WEB_TOOL_SCHEMAS[1]!.parameters, cache_control: EPHEMERAL },
    ]);
    expect(body.system, "the system prompt is not a block carrying cache_control").toEqual([{ type: "text", text: SYSTEM, cache_control: EPHEMERAL }]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Find the opening hours of the York shop.", cache_control: EPHEMERAL }] },
      { role: "assistant", content: "They open at nine." },
      { role: "user", content: [{ type: "text", text: "And on Sunday?", cache_control: EPHEMERAL }] },
    ]);
    expect(body).toMatchObject({ model: "claude-opus-5-5", stream: true, max_tokens: 1024 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe(TEST_KEY);
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(completion).toMatchObject({ text: "ready", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 12, outputTokens: 2, estimated: false });
  });
});

describe("[C14] a tool_use block becomes a call", () => {
  const SEARCH = { query: "York shop Sunday hours", limit: 3 };
  const TURN = [
    { type: "thinking", thinking: "", signature: "sig-opaque-1" },
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "toolu_01", name: "web_search", input: SEARCH },
  ];

  it("surfaces the call on the completion, with the turn as returned (thinking signature kept) for the next request", async () => {
    await fakeAnthropic((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply(TURN, { input_tokens: 40 }, "tool_use", 30));
    });
    const gateway = await anthropicGateway();

    const completion = await gateway.complete({ messages: SOLO_MESSAGES, tools: WEB_TOOL_SCHEMAS, model: "claude-opus-5-5" });

    expect(completion.toolCalls).toEqual([{ id: "toolu_01", name: "web_search", arguments: SEARCH }]);
    expect(completion.providerContent).toEqual(TURN);
    expect(completion).toMatchObject({ text: "Let me look.", finishReason: "tool_use", outputTokens: 30 });
  });
});

describe("[C14] cache usage is read, not dropped", () => {
  /** Anthropic: total input = cache_read + cache_creation + input_tokens (prompt-caching docs, "Tracking cache performance"). */
  const CACHED = { input_tokens: 200_000, cache_creation_input_tokens: 400_000, cache_read_input_tokens: 1_000_000 };

  it("reports the whole prompt as input, the cache reads as cached and the cache writes as written", async () => {
    await fakeAnthropic((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply([{ type: "text", text: "ok" }], CACHED, "end_turn", 100_000));
    });
    const gateway = await anthropicGateway();

    const completion = await gateway.complete({ messages: SOLO_MESSAGES, model: "claude-sonnet-4-6" });

    expect(completion).toMatchObject({ inputTokens: 1_600_000, cachedInputTokens: 1_000_000, cacheWriteInputTokens: 400_000, outputTokens: 100_000, estimated: false });
  });

  it("prices the reads at the cached rate and the writes at the write rate: 390 cents on claude-sonnet-4-6", async () => {
    await fakeAnthropic((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply([{ type: "text", text: "ok" }], CACHED, "end_turn", 100_000));
    });
    const gateway = await anthropicGateway();

    const completion = await gateway.complete({ messages: SOLO_MESSAGES, model: "claude-sonnet-4-6" });

    // 200k plain x $3 = 60; 1M read x $0.30 = 30; 400k written x $3.75 = 150; 100k out x $15 = 150 (pricing page).
    expect(completion).toMatchObject({ costCents: 390, unpriced: false, priced_as_default: false });
  });
});

/** Resolves "closed" when `res` is torn down before it was ended, or "still open" after `ms`. */
function closedWithin(res: Promise<http.ServerResponse>, ms: number): Promise<string> {
  return Promise.race([
    res.then((r) => new Promise<string>((resolve) => r.on("close", () => resolve(r.writableEnded ? "ended normally" : "closed")))),
    new Promise<string>((resolve) => setTimeout(() => resolve("still open"), ms)),
  ]);
}

/** A reply that sends its start and one token, then holds the connection open. */
const HELD_OPEN = sse([
  { type: "message_start", message: { id: "msg_held", type: "message", role: "assistant", content: [], model: "claude-test", stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
]);

describe("[C14] cancellation", () => {
  it("an abort signal cancels the request: the fake server sees the connection close", async () => {
    let held!: (res: http.ServerResponse) => void;
    const response = new Promise<http.ServerResponse>((resolve) => (held = resolve));
    await fakeAnthropic((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(HELD_OPEN);
      held(res);
    });
    const gateway = await anthropicGateway();
    const controller = new AbortController();
    const closed = closedWithin(response, 2_000);

    const events: string[] = [];
    for await (const event of gateway.stream({ messages: SOLO_MESSAGES, model: "claude-opus-5-5", signal: controller.signal })) {
      events.push(event.type === "finish" ? `finish:${event.reason}` : event.type);
      if (event.type === "token") controller.abort(new Error("the user pressed Ctrl+C"));
    }

    // The partial answer is still metered (an estimated usage row) before the aborted finish, as on every route.
    expect(events).toEqual(["token", "usage", "finish:aborted"]);
    expect(await closed).toBe("closed");
  });
});

describe("[C14] the headers timeout: 60 s by default, configurable", () => {
  /** A server that takes the request and never answers. `closed`: whether its socket was torn down within 1.5 s. */
  async function silentServer(): Promise<{ readonly closed: Promise<string> }> {
    let held!: (res: http.ServerResponse) => void;
    const response = new Promise<http.ServerResponse>((resolve) => (held = resolve));
    await fakeAnthropic((_req, res) => held(res));
    return { closed: closedWithin(response, 1_500) };
  }

  async function outcomeWithin(gateway: Awaited<ReturnType<typeof anthropicGateway>>): Promise<string> {
    const controller = new AbortController();
    const outcome = await Promise.race([
      gateway.complete({ messages: SOLO_MESSAGES, model: "claude-opus-5-5", signal: controller.signal }).then(() => "completed", (error: unknown) => String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("no timeout fired within 1.5 s"), 1_500)),
    ]);
    controller.abort();
    return outcome;
  }

  it("config `anthropicTimeoutMs` ends a request whose headers never come, names the setting, and closes the socket", async () => {
    const { closed } = await silentServer();
    const outcome = await outcomeWithin(await anthropicGateway({ anthropicTimeoutMs: 150 }));
    expect(outcome).toMatch(/TimeoutError: anthropic sent no response headers within 150 ms \(TRENT_ANTHROPIC_TIMEOUT_MS\)/);
    expect(await closed).toBe("closed");
  });

  it("the env bridge sets it for a gateway built without the field", async () => {
    await silentServer();
    process.env.TRENT_ANTHROPIC_TIMEOUT_MS = "150";
    expect(await outcomeWithin(await anthropicGateway())).toMatch(/within 150 ms/);
  });

  it("resolves config, then env, then 60,000 ms; a value that is not a positive number is ignored", () => {
    expect(ANTHROPIC_HEADERS_TIMEOUT_MS).toBe(60_000);
    expect(resolveAnthropicTimeoutMs(undefined, {})).toBe(60_000);
    expect(resolveAnthropicTimeoutMs(250, { TRENT_ANTHROPIC_TIMEOUT_MS: "900" })).toBe(250);
    expect(resolveAnthropicTimeoutMs(undefined, { TRENT_ANTHROPIC_TIMEOUT_MS: "900" })).toBe(900);
    expect(resolveAnthropicTimeoutMs(undefined, { TRENT_ANTHROPIC_TIMEOUT_MS: "soon" })).toBe(60_000);
    expect(resolveAnthropicTimeoutMs(-5, {})).toBe(60_000);
  });
});

describe("[C14] reasoning_effort goes where Anthropic documents it; temperature only where it is accepted", () => {
  type Case = { model: string; effort?: "none" | "minimal" | "low" | "medium" | "high"; expect: Record<string, unknown>; absent: string[]; dropped?: boolean };
  // effort: https://platform.claude.com/docs/en/build-with-claude/effort (supportedModels; low, medium, high on all).
  // budget: https://platform.claude.com/docs/en/build-with-claude/extended-thinking (>= 1,024 and < max_tokens).
  // temperature: rejected when non-default on Opus 4.7 and later and on Sonnet 5 (their migration guides).
  const CASES: Case[] = [
    { model: "claude-opus-5-5", effort: "low", expect: { output_config: { effort: "low" }, max_tokens: 2000 }, absent: ["thinking", "temperature"] },
    { model: "claude-opus-5-5", effort: "minimal", expect: { output_config: { effort: "low" } }, absent: ["thinking", "temperature"] },
    { model: "claude-sonnet-5", effort: "high", expect: { output_config: { effort: "high" } }, absent: ["thinking", "temperature"] },
    { model: "claude-sonnet-4-6", expect: { temperature: 0.2 }, absent: ["thinking", "output_config"] },
    { model: "claude-sonnet-4-6", effort: "medium", expect: { output_config: { effort: "medium" }, temperature: 0.2 }, absent: ["thinking"] },
    { model: "claude-haiku-4-5-20251001", effort: "high", expect: { thinking: { type: "enabled", budget_tokens: 16_000 }, max_tokens: 18_000 }, absent: ["output_config", "temperature"] },
    { model: "claude-haiku-4-5-20251001", effort: "low", expect: { thinking: { type: "enabled", budget_tokens: 1_024 }, max_tokens: 3_024 }, absent: ["output_config", "temperature"] },
    { model: "claude-opus-4-5-20251101", effort: "medium", expect: { output_config: { effort: "medium" }, thinking: { type: "enabled", budget_tokens: 8_000 } }, absent: ["temperature"] },
    { model: "claude-opus-5-5", effort: "none", expect: {}, absent: ["output_config", "thinking", "temperature"], dropped: true },
    { model: "claude-next-unlisted", effort: "high", expect: {}, absent: ["output_config", "thinking", "temperature"], dropped: true },
  ];

  for (const c of CASES) {
    it(`${c.model}, effort ${c.effort ?? "unset"}`, async () => {
      const { seen } = await fakeAnthropic();
      const logs: string[] = [];
      const gateway = await anthropicGateway({ retryLog: (event: string) => logs.push(event) });

      await gateway.complete({ messages: SOLO_MESSAGES, model: c.model, maxTokens: 2000, temperature: 0.2, ...(c.effort ? { reasoningEffort: c.effort } : {}) });

      const body = sentBody(seen);
      expect(body).toMatchObject(c.expect);
      for (const field of c.absent) expect(body, `${field} must not be sent to ${c.model}`).not.toHaveProperty(field);
      expect(logs.includes("model_gateway.reasoning_effort_not_sent")).toBe(c.dropped === true);
    });
  }
});

describe("[C14] a native tool loop goes back as tool_use and tool_result blocks", () => {
  const SEARCH = { query: "York shop Sunday hours" };
  const TURN = [{ type: "thinking", thinking: "", signature: "sig-opaque-1" }, { type: "text", text: "Let me look." }, { type: "tool_use", id: "toolu_01", name: "web_search", input: SEARCH }];

  it("replays the provider's own turn verbatim and answers its call with a tool_result carrying the breakpoint", async () => {
    const { seen } = await fakeAnthropic();
    const gateway = await anthropicGateway();
    const messages: GatewayMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: "Find the opening hours of the York shop." },
      { role: "assistant", content: "Let me look.", toolCalls: [{ id: "toolu_01", name: "web_search", arguments: SEARCH }], providerContent: TURN },
      { role: "user", content: "York shop: open 10 to 4 on Sunday.", toolCallId: "toolu_01" },
    ];

    await gateway.complete({ messages, tools: WEB_TOOL_SCHEMAS, model: "claude-opus-5-5" });

    expect(sentBody(seen).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Find the opening hours of the York shop.", cache_control: EPHEMERAL }] },
      { role: "assistant", content: TURN },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "York shop: open 10 to 4 on Sunday.", cache_control: EPHEMERAL }] },
    ]);
  });

  it("without the provider's turn, builds tool_use blocks (no empty text block) and merges consecutive results into one user turn", async () => {
    const { seen } = await fakeAnthropic();
    const gateway = await anthropicGateway();
    const calls = [{ id: "toolu_a", name: "web_search", arguments: { query: "York" } }, { id: "toolu_b", name: "web_search", arguments: { query: "Leeds" } }];
    const messages: GatewayMessage[] = [
      { role: "user", content: "Compare two shops." },
      { role: "assistant", content: "", toolCalls: calls },
      { role: "user", content: "York: 10 to 4.", toolCallId: "toolu_a" },
      { role: "user", content: "Leeds: the search failed.", toolCallId: "toolu_b", isError: true },
      { role: "user", content: "Which is open later?" },
    ];

    await gateway.complete({ messages, tools: WEB_TOOL_SCHEMAS, model: "claude-sonnet-4-6" });

    expect(sentBody(seen).messages).toEqual([
      { role: "user", content: "Compare two shops." },
      { role: "assistant", content: calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })) },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "York: 10 to 4." },
          { type: "tool_result", tool_use_id: "toolu_b", content: "Leeds: the search failed.", is_error: true, cache_control: EPHEMERAL },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Which is open later?", cache_control: EPHEMERAL }] },
    ]);
  });
});

describe("[C14] a route without native tools reads the same conversation as text", () => {
  it("google gets role and content only (calls rendered into the assistant text), and no tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const chunks = [{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 50, completion_tokens: 1 } }];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    process.env.GOOGLE_BASE_URL = "http://127.0.0.1:9/v1beta/openai/";
    const gateway = await createModelGateway({
      apiKeys: { google: "test-google-key" }, preferredProvider: "google", allowedProviders: ["google"], models: { executor: "gemini-3.5-flash-lite" },
      fetchImpl, retry: { attempts: 1 }, retryLog: () => undefined, redactionLog: () => undefined,
    });
    const messages: GatewayMessage[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: "Find the opening hours of the York shop." },
      { role: "assistant", content: "Let me look.", toolCalls: [{ id: "toolu_01", name: "web_search", arguments: { query: "York" } }], providerContent: [{ type: "text", text: "Let me look." }] },
      { role: "user", content: "York shop: open 10 to 4 on Sunday.", toolCallId: "toolu_01" },
    ];

    await gateway.complete({ messages, tools: WEB_TOOL_SCHEMAS });

    expect(bodies[0]!.messages).toEqual([
      { role: "system", content: SYSTEM },
      { role: "user", content: "Find the opening hours of the York shop." },
      { role: "assistant", content: 'Let me look.\n[called web_search {"query":"York"}]' },
      { role: "user", content: "York shop: open 10 to 4 on Sunday." },
    ]);
    expect(bodies[0]).not.toHaveProperty("tools");
  });
});

describe("[C14] failures are the retry policy's to classify", () => {
  it("a 429 and an overloaded_error event inside the stream are both retried; the third answer is used", async () => {
    const { seen } = await fakeAnthropic((_req, res, entry) => {
      const attempt = seen.indexOf(entry);
      if (attempt === 0) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (attempt === 1) res.end(sse([{ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]));
      else res.end(READY);
    });
    const logs: Array<Record<string, unknown>> = [];
    const gateway = await anthropicGateway({ retry: { attempts: 3, sleep: async () => undefined }, retryLog: (event: string, fields: Record<string, unknown>) => logs.push({ event, ...fields }) });

    const completion = await gateway.complete({ messages: SOLO_MESSAGES, model: "claude-opus-5-5" });

    expect(seen).toHaveLength(3);
    expect(completion.text).toBe("ready");
    expect(logs.filter((log) => log.event === "model_gateway.retry").map((log) => log.status)).toEqual([429, 529]);
  });
});
