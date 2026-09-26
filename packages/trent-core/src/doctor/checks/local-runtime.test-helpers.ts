/**
 * A fake local model runtime for the doctor's Local Model tests: Ollama, llama.cpp `llama-server` or
 * LM Studio, answered in-process through the doctor's fetch seam. Nothing here opens a socket.
 *
 * The routes and response shapes are the documented ones (read 2026-09-26): Ollama `/api/version`,
 * `/api/tags`, `/api/show`, `/api/ps`; llama.cpp `/props` (`default_generation_settings.n_ctx`,
 * `total_slots`, `build_info`); LM Studio `/api/v1/models` (`loaded_instances[].config`); and the
 * OpenAI-compatible `/v1/models` and streamed `/v1/chat/completions` all three serve.
 */
import type { FetchLike } from "../types.js";
import { SMOKE_CASES, type SmokeCaseId } from "./local-smoke.js";

export type FakeRuntimeKind = "ollama" | "llama.cpp" | "lmstudio";

export interface FakeChatRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** The smoke case this request is, when its user message is one of `SMOKE_CASES`. */
  readonly caseId?: SmokeCaseId;
  readonly body: Record<string, unknown>;
}

export interface FakeRuntimeOptions {
  readonly kind: FakeRuntimeKind;
  readonly version?: string;
  readonly models: readonly string[];
  /** Ollama models listed as cloud models (`remote_host` set, size 0). */
  readonly cloud?: readonly string[];
  /** Ollama: `num_ctx` in the Modelfile parameters of `/api/show`. */
  readonly numCtx?: number;
  /** The window of the loaded model: Ollama `/api/ps`, LM Studio `loaded_instances`, llama.cpp `n_ctx`. */
  readonly loadedContext?: number;
  readonly slots?: number;
  /** The content the model streams back. Defaults to a reply that passes every smoke case. */
  readonly reply?: (request: FakeChatRequest) => string;
  /** Streamed as `delta.reasoning` before the content, as Ollama does for a thinking model. */
  readonly reasoning?: string;
  /** Delay before the first chunk of a long (time-to-first-token) prompt. */
  readonly firstTokenDelayMs?: number;
  /** `usage.prompt_tokens` reported for a long prompt. */
  readonly longPromptTokens?: number;
}

export interface FakeRuntime {
  readonly fetchImpl: FetchLike;
  readonly calls: { method: string; url: string; body?: Record<string, unknown> }[];
  chatCalls(): FakeChatRequest[];
}

/** A long prompt is the time-to-first-token probe; the smoke prompts are a few hundred tokens. */
const LONG_PROMPT_CHARS = 8_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

/** An OpenAI-compatible SSE body: one `data:` line per chunk, then `[DONE]`. */
export function sseResponse(chunks: readonly unknown[], firstDelayMs = 0, signal?: AbortSignal | null): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (firstDelayMs > 0) await sleep(firstDelayMs, signal);
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolTurn(action: string): string {
  return JSON.stringify({ toolCall: { name: "file_ops", action }, summary: null });
}

/** What a model that keeps the wrapper's tool-call contract answers to each smoke case. */
export function wellBehavedReply(caseId: SmokeCaseId | undefined): string {
  switch (caseId) {
    case "call":
      return toolTurn(`read_file ${JSON.stringify({ path: "notes/todo.md" })}`);
    case "abstain":
      return JSON.stringify({ toolCall: null, summary: "17 + 25 = 42." });
    case "escaping":
      return toolTurn(`write_file ${JSON.stringify({ path: "quote.txt", content: 'She said "yes".\nThen she left.' })}`);
    case "required":
      return toolTurn(`search_files ${JSON.stringify({ pattern: "invoice" })}`);
    case "unknown-tool":
      return JSON.stringify({ toolCall: null, summary: "No email tool is available, so nothing was sent." });
    default:
      return "OK";
  }
}

function contentOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : "";
}

function chatRequest(body: Record<string, unknown>): FakeChatRequest {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = contentOf(messages.find((m) => (m as { role?: unknown }).role === "system"));
  const user = contentOf([...messages].reverse().find((m) => (m as { role?: unknown }).role === "user"));
  const caseId = SMOKE_CASES.find((smoke) => smoke.user === user)?.id;
  return { model: String(body.model), system, user, ...(caseId === undefined ? {} : { caseId }), body };
}

function modelKey(id: string): string {
  return id.includes(":") ? id : `${id}:latest`;
}

export function fakeRuntime(baseUrl: string, options: FakeRuntimeOptions): FakeRuntime {
  const origin = new URL(baseUrl).origin;
  const calls: FakeRuntime["calls"] = [];
  const cloud = new Set(options.cloud ?? []);
  const served = [...options.models, ...cloud];
  const reply = options.reply ?? ((request: FakeChatRequest) => wellBehavedReply(request.caseId));
  let loaded = false;

  function chat(body: Record<string, unknown>, signal?: AbortSignal | null): Response {
    const request = chatRequest(body);
    if (!served.includes(request.model) && !served.map(modelKey).includes(modelKey(request.model))) {
      return json({ error: { message: `model "${request.model}" not found, try pulling it first` } }, 404);
    }
    loaded = true;
    const long = request.user.length > LONG_PROMPT_CHARS;
    const text = reply(request);
    const half = Math.ceil(text.length / 2);
    const chunks: unknown[] = [];
    if (options.reasoning) chunks.push({ choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning: options.reasoning } }] });
    chunks.push({ choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, half) } }] });
    chunks.push({ choices: [{ index: 0, delta: { content: text.slice(half) } }] });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const promptTokens = long ? options.longPromptTokens ?? Math.ceil(request.user.length / 4) : 180;
    chunks.push({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: Math.ceil(text.length / 4), total_tokens: promptTokens + Math.ceil(text.length / 4) } });
    return sseResponse(chunks, long ? options.firstTokenDelayMs ?? 0 : 0, signal);
  }

  function ollama(path: string, method: string, body: Record<string, unknown> | undefined): Response | undefined {
    if (path === "/api/version") return json({ version: options.version ?? "0.32.9" });
    if (path === "/api/tags") {
      return json({
        models: served.map((name) => ({
          name: modelKey(name),
          model: modelKey(name),
          size: cloud.has(name) ? 0 : 2_500_000_000,
          ...(cloud.has(name) ? { remote_model: name, remote_host: "https://ollama.com:443" } : {}),
        })),
      });
    }
    if (path === "/api/show" && method === "POST") {
      const name = String(body?.model ?? "");
      if (!served.map(modelKey).includes(modelKey(name))) return json({ error: `model '${name}' not found` }, 404);
      return json({
        capabilities: ["completion", "tools", "thinking"],
        parameters: options.numCtx === undefined ? "temperature 1\ntop_k 20" : `num_ctx ${options.numCtx}\ntemperature 1`,
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
      });
    }
    if (path === "/api/ps") {
      const models = loaded && options.loadedContext !== undefined
        ? options.models.map((name) => ({ name: modelKey(name), model: modelKey(name), context_length: options.loadedContext }))
        : [];
      return json({ models });
    }
    return undefined;
  }

  function llamaCpp(path: string): Response | undefined {
    if (path === "/props") {
      return json({
        default_generation_settings: { n_ctx: options.loadedContext ?? 4096 },
        total_slots: options.slots ?? 1,
        model_path: `/models/${options.models[0] ?? "model"}.gguf`,
        build_info: options.version ?? "b6500-0a1b2c3",
      });
    }
    return undefined;
  }

  function lmStudio(path: string): Response | undefined {
    if (path === "/api/v1/models") {
      return json({
        models: options.models.map((key) => ({
          type: "llm",
          key,
          loaded_instances: loaded && options.loadedContext !== undefined
            ? [{ id: key, config: { context_length: options.loadedContext, parallel: options.slots ?? 4 } }]
            : [],
          max_context_length: 262144,
        })),
      });
    }
    return undefined;
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body = raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ method, url, ...(body === undefined ? {} : { body }) });
    const parsed = new URL(url);
    if (parsed.origin !== origin) throw new TypeError(`fetch failed: ${parsed.host} is not this fake runtime`);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path === "/v1/chat/completions" && method === "POST" && body !== undefined) return chat(body, init?.signal);
    if (path === "/v1/models") return json({ object: "list", data: served.map((id) => ({ id, object: "model" })) });
    const answer =
      options.kind === "ollama" ? ollama(path, method, body)
      : options.kind === "llama.cpp" ? llamaCpp(path)
      : lmStudio(path);
    if (answer !== undefined) return answer;
    // LM Studio answers an unknown route with 200 and an error object; the others with 404.
    return options.kind === "lmstudio" ? json({ error: "Unexpected endpoint or method." }) : new Response("404 page not found", { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    chatCalls: () => calls.filter((call) => call.url.endsWith("/chat/completions") && call.body !== undefined).map((call) => chatRequest(call.body!)),
  };
}
