/**
 * Probes of a local model runtime for the Local Model check, all through the doctor's fetch seam.
 *
 * Identification is by what answers, not by the provider name, so a llama.cpp `llama-server` put
 * behind `LMSTUDIO_BASE_URL` or `OLLAMA_BASE_URL` is reported as llama.cpp:
 *   Ollama     `GET /api/version` -> `{ version }`; models `/api/tags`; `/api/show` (Modelfile
 *              `num_ctx`, training `context_length`, capabilities); `/api/ps` (`context_length` of the
 *              loaded model, the window actually in use). https://docs.ollama.com/api
 *   llama.cpp  `GET /props` -> `default_generation_settings.n_ctx`, `total_slots`, `build_info`.
 *              https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *   LM Studio  `GET /v1/models`, then `GET /api/v1/models` -> `loaded_instances[].config`
 *              (`context_length`, `parallel`). https://lmstudio.ai/docs/developer/rest/list
 * Anything else that serves `GET /v1/models` is a generic OpenAI-compatible server.
 */
import { probeHttp, timedOut, withDeadline } from "../probe.js";
import type { FetchLike } from "../types.js";

export type LocalRuntimeKind = "ollama" | "llama.cpp" | "lmstudio" | "openai-compatible";

export const RUNTIME_LABELS: Readonly<Record<LocalRuntimeKind, string>> = {
  ollama: "Ollama",
  "llama.cpp": "llama.cpp",
  lmstudio: "LM Studio",
  "openai-compatible": "OpenAI-compatible server",
};

export interface ProbeSeam {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs: number;
}

type Answer = { kind: "json"; status: number; body: unknown } | { kind: "http"; status: number } | { kind: "down"; why: "timeout" | "network" };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

async function ask(url: string, seam: ProbeSeam, init: RequestInit = { method: "GET" }): Promise<Answer> {
  const probe = await probeHttp(url, init, { ...(seam.fetchImpl === undefined ? {} : { fetchImpl: seam.fetchImpl }), timeoutMs: seam.timeoutMs });
  if (probe.kind !== "response") return { kind: "down", why: probe.kind };
  const status = probe.response.status;
  const body = await withDeadline(async () => {
    try {
      return { parsed: (await probe.response.json()) as unknown };
    } catch {
      return undefined;
    }
  }, seam.timeoutMs);
  return timedOut(body) || body === undefined ? { kind: "http", status } : { kind: "json", status, body: body.parsed };
}

function okJson(answer: Answer): Json | undefined {
  return answer.kind === "json" && answer.status >= 200 && answer.status < 300 && isObject(answer.body) ? answer.body : undefined;
}

export interface RuntimeIdentity {
  readonly kind: LocalRuntimeKind;
  readonly version?: string;
  /** llama.cpp only: read from `/props` at detection. */
  readonly nCtx?: number;
  readonly slots?: number;
}

export type Detection =
  | { readonly ok: true; readonly identity: RuntimeIdentity }
  | { readonly ok: false; readonly why: "timeout" | "network" | "unrecognised"; readonly status?: number };

/** `http://host:port/v1` -> `http://host:port`: the native routes live at the server root. */
export function runtimeRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export async function detectRuntime(baseUrl: string, seam: ProbeSeam): Promise<Detection> {
  const root = runtimeRoot(baseUrl);
  const version = await ask(`${root}/api/version`, seam);
  // The first probe decides reachability: a refused or silent port will not answer the next one.
  if (version.kind === "down") return { ok: false, why: version.why };
  const ollama = okJson(version);
  if (typeof ollama?.version === "string") return { ok: true, identity: { kind: "ollama", version: ollama.version } };

  const props = okJson(await ask(`${root}/props`, seam));
  if (isObject(props?.default_generation_settings)) {
    const settings = props!.default_generation_settings as Json;
    return {
      ok: true,
      identity: {
        kind: "llama.cpp",
        ...(typeof props!.build_info === "string" ? { version: props!.build_info } : {}),
        ...(count(settings.n_ctx) === undefined ? {} : { nCtx: count(settings.n_ctx) }),
        ...(count(props!.total_slots) === undefined ? {} : { slots: count(props!.total_slots) }),
      },
    };
  }

  const models = await ask(`${baseUrl.replace(/\/+$/, "")}/models`, seam);
  if (Array.isArray(okJson(models)?.data)) {
    const lmStudio = okJson(await ask(`${root}/api/v1/models`, seam));
    return { ok: true, identity: { kind: Array.isArray(lmStudio?.models) ? "lmstudio" : "openai-compatible" } };
  }
  return { ok: false, why: "unrecognised", ...(models.kind === "down" ? {} : { status: models.status }) };
}

export interface ServedModel {
  readonly id: string;
  /** An Ollama cloud model: listed locally, run on ollama.com. */
  readonly cloud: boolean;
}

/** The models the runtime serves, or the reason the list could not be read. */
export async function listServedModels(identity: RuntimeIdentity, baseUrl: string, seam: ProbeSeam): Promise<ServedModel[] | string> {
  if (identity.kind === "ollama") {
    const tags = okJson(await ask(`${runtimeRoot(baseUrl)}/api/tags`, seam));
    if (!Array.isArray(tags?.models)) return "GET /api/tags did not return a model list";
    return (tags!.models as unknown[]).filter(isObject).map((entry) => {
      const id = String(entry.name ?? entry.model ?? "");
      return { id, cloud: typeof entry.remote_host === "string" || /[:-]cloud$/.test(id) };
    }).filter((model) => model.id !== "");
  }
  const listing = okJson(await ask(`${baseUrl.replace(/\/+$/, "")}/models`, seam));
  if (!Array.isArray(listing?.data)) return "GET /v1/models did not return a model list";
  return (listing!.data as unknown[]).filter(isObject).map((entry) => ({ id: String(entry.id ?? ""), cloud: false })).filter((model) => model.id !== "");
}

/** Ollama names an untagged model `<name>:latest`. */
function ollamaKey(id: string): string {
  const lastSegment = id.slice(id.lastIndexOf("/") + 1);
  return lastSegment.includes(":") ? id : `${id}:latest`;
}

export function findServedModel(model: string, served: readonly ServedModel[], kind: LocalRuntimeKind): ServedModel | undefined {
  if (kind === "ollama") return served.find((entry) => ollamaKey(entry.id) === ollamaKey(model));
  return served.find((entry) => entry.id === model);
}

export interface OllamaShow {
  readonly numCtx?: number;
  readonly trainedContext?: number;
  readonly capabilities?: readonly string[];
}

export async function readOllamaShow(baseUrl: string, model: string, seam: ProbeSeam): Promise<OllamaShow> {
  const show = okJson(await ask(`${runtimeRoot(baseUrl)}/api/show`, seam, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }));
  if (show === undefined) return {};
  const numCtx = typeof show.parameters === "string" ? count(Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters)?.[1])) : undefined;
  const info = isObject(show.model_info) ? show.model_info : {};
  const trained = Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1];
  const capabilities = Array.isArray(show.capabilities) ? show.capabilities.filter((c): c is string => typeof c === "string") : undefined;
  return {
    ...(numCtx === undefined ? {} : { numCtx }),
    ...(count(trained) === undefined ? {} : { trainedContext: count(trained) }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

/** Ollama `/api/ps`: the context window of the model as it is loaded right now. */
export async function readOllamaLoadedContext(baseUrl: string, model: string, seam: ProbeSeam): Promise<number | undefined> {
  const ps = okJson(await ask(`${runtimeRoot(baseUrl)}/api/ps`, seam));
  if (!Array.isArray(ps?.models)) return undefined;
  const entry = (ps!.models as unknown[]).filter(isObject).find((m) => ollamaKey(String(m.name ?? m.model ?? "")) === ollamaKey(model));
  return count(entry?.context_length);
}

/** LM Studio: the loaded instance's context length and parallel predictions. */
export async function readLmStudioLoaded(baseUrl: string, model: string, seam: ProbeSeam): Promise<{ contextLength?: number; parallel?: number }> {
  const listing = okJson(await ask(`${runtimeRoot(baseUrl)}/api/v1/models`, seam));
  if (!Array.isArray(listing?.models)) return {};
  for (const entry of (listing!.models as unknown[]).filter(isObject)) {
    const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances.filter(isObject) : [];
    const instance = instances.find((i) => i.id === model) ?? (entry.key === model ? instances[0] : undefined);
    if (instance === undefined) continue;
    const config = isObject(instance.config) ? instance.config : {};
    const contextLength = count(config.context_length);
    const parallel = count(config.parallel);
    return { ...(contextLength === undefined ? {} : { contextLength }), ...(parallel === undefined ? {} : { parallel }) };
  }
  return {};
}
