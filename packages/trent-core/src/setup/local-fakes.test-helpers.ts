/**
 * [L2] Fake local model runtimes for `setup --mode local`: Ollama, LM Studio and a llama.cpp
 * `llama-server`, each at its own origin, answering the documented routes with the documented shapes
 * (read 2026-09-26):
 *   Ollama     GET /api/version, GET /api/tags (`size`, `details`, `capabilities` as 0.32.9 sends them),
 *              POST /api/show (`capabilities`), POST /api/pull (NDJSON)            https://docs.ollama.com/api
 *   LM Studio  GET /api/v1/models (`type`, `key`, `size_bytes`, `capabilities`), GET /v1/models
 *                                                              https://lmstudio.ai/docs/developer/rest/list
 *   llama.cpp  GET /props (`default_generation_settings.n_ctx`, `total_slots`), GET /v1/models (one
 *              element, `meta.size`)  https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 * Any other origin refuses like a closed port. `handle` serves one Request, so a test can put the same
 * fake behind a real `node:http` server.
 */

export interface FakeOllamaModel {
  readonly name: string;
  readonly size?: number;
  readonly capabilities?: readonly string[];
  /** An Ollama cloud model: listed locally, run on ollama.com (`remote_host`). */
  readonly remote?: boolean;
}

export interface FakeLocalSpec {
  readonly ollama?: {
    readonly url?: string;
    readonly models: readonly FakeOllamaModel[];
    /** false: `/api/tags` carries no `capabilities` (Ollama before they were listed there). */
    readonly tagsCapabilities?: boolean;
  };
  readonly lmstudio?: {
    readonly url?: string;
    readonly models: ReadonlyArray<{ key: string; type: "llm" | "embedding"; size_bytes?: number; tool?: boolean }>;
  };
  readonly llamacpp?: { readonly url: string; readonly id: string; readonly size?: number; readonly nCtx?: number; readonly slots?: number };
}

export interface FakeLocal {
  readonly fetch: typeof fetch;
  handle(request: Request): Promise<Response>;
  /** `METHOD url`, in order. */
  readonly calls: string[];
  /** Models pulled through `/api/pull`, in order. */
  readonly pulled: string[];
}

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";

/** Sizes as the runtimes report them: `ollama list` shows 6.6 GB and 639 MB for these. */
export const SIZES: Readonly<Record<string, number>> = {
  "qwen3.5:9b": 6_594_474_711,
  "qwen3-embedding:0.6b": 639_150_858,
  "qwen3.6:27b": 17_990_000_000,
  "nomic-embed-text:latest": 274_302_450,
};

export const CHAT_CAPS = ["completion", "tools", "thinking"] as const;

function refused(): never {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

function ndjson(lines: object[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

export function fakeLocal(spec: FakeLocalSpec): FakeLocal {
  const calls: string[] = [];
  const pulled: string[] = [];
  const ollamaModels: FakeOllamaModel[] = [...(spec.ollama?.models ?? [])];
  const ollamaOrigin = spec.ollama?.url ?? OLLAMA;
  const lmOrigin = spec.lmstudio?.url ?? LMSTUDIO;

  async function ollama(path: string, request: Request): Promise<Response> {
    if (path === "/api/version") return Response.json({ version: "0.32.9" });
    if (path === "/api/tags") {
      return Response.json({
        models: ollamaModels.map((m) => ({
          name: m.name,
          model: m.name,
          size: m.size ?? SIZES[m.name] ?? 1_000_000_000,
          details: { format: "gguf", parameter_size: "9.7B", quantization_level: "Q4_K_M" },
          ...(m.remote ? { remote_host: "https://ollama.com:443" } : {}),
          ...(spec.ollama?.tagsCapabilities === false || m.capabilities === undefined ? {} : { capabilities: m.capabilities }),
        })),
      });
    }
    if (path === "/api/show" && request.method === "POST") {
      const { model } = (await request.json()) as { model: string };
      const found = ollamaModels.find((m) => m.name === model);
      return found === undefined ? Response.json({ error: `model '${model}' not found` }, { status: 404 }) : Response.json({ capabilities: found.capabilities ?? ["completion"] });
    }
    if (path === "/api/pull" && request.method === "POST") {
      const { model } = (await request.json()) as { model: string };
      pulled.push(model);
      ollamaModels.push({ name: model, capabilities: /embed/.test(model) ? ["embedding"] : [...CHAT_CAPS] });
      return ndjson([{ status: "pulling manifest" }, { status: "pulling 6488c96f", total: 100, completed: 100 }, { status: "success" }]);
    }
    return new Response("404 page not found", { status: 404 });
  }

  function lmstudio(path: string): Response {
    const models = spec.lmstudio?.models ?? [];
    if (path === "/api/v1/models") {
      return Response.json({
        models: models.map((m) => ({
          type: m.type,
          key: m.key,
          ...(m.size_bytes === undefined ? {} : { size_bytes: m.size_bytes }),
          params_string: m.type === "llm" ? "9B" : null,
          quantization: { name: "Q4_K_M", bits_per_weight: 4 },
          loaded_instances: [],
          ...(m.type === "llm" ? { capabilities: { vision: false, trained_for_tool_use: m.tool ?? true } } : {}),
        })),
      });
    }
    if (path === "/v1/models") return Response.json({ object: "list", data: models.map((m) => ({ id: m.key, object: "model" })) });
    return Response.json({ error: "Unexpected endpoint or method." }, { status: 404 });
  }

  function llamacpp(path: string): Response {
    const server = spec.llamacpp!;
    if (path === "/props") {
      return Response.json({ default_generation_settings: { n_ctx: server.nCtx ?? 65536 }, total_slots: server.slots ?? 1, build_info: "b6500-abc1234" });
    }
    if (path === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: server.id, object: "model", owned_by: "llamacpp", meta: { n_params: 9_650_000_000, size: server.size ?? 5_680_000_000 } }] });
    }
    return Response.json({ error: { code: 404, message: "File Not Found", type: "not_found_error" } }, { status: 404 });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.origin}${url.pathname}`);
    if (spec.ollama !== undefined && url.origin === new URL(ollamaOrigin).origin) return await ollama(url.pathname, request);
    if (spec.lmstudio !== undefined && url.origin === new URL(lmOrigin).origin) return lmstudio(url.pathname);
    if (spec.llamacpp !== undefined && url.origin === new URL(spec.llamacpp.url).origin) return llamacpp(url.pathname);
    return refused();
  }

  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => await handle(new Request(input, init))) as typeof fetch;
  return { fetch: doFetch, handle, calls, pulled };
}
