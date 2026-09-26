/**
 * [L2] Which local model runtimes answer on this machine, and what each one has.
 *
 * `setup --mode local` probes Ollama and LM Studio where a run will send its calls (the gateway's own
 * base URLs: `OLLAMA_BASE_URL`, `LMSTUDIO_BASE_URL`, else 127.0.0.1:11434 and :1234), plus any
 * `--base-url` the operator names, which is how a llama.cpp `llama-server` is found. A runtime is
 * identified by what answers, not by where it was expected (the doctor's rule, `doctor/checks/
 * local-runtime.ts`; setup does not import `doctor/`):
 *
 *   Ollama     GET /api/version -> {version}; GET /api/tags -> models with `size`, `details` and, since
 *              0.32, `capabilities` (`completion`, `tools`, `thinking`, `embedding`, ...); POST /api/show
 *              -> `capabilities` for one model.                              https://docs.ollama.com/api
 *   llama.cpp  GET /props -> `default_generation_settings.n_ctx`, `total_slots`, `build_info`;
 *              GET /v1/models -> one element with `meta.size`.
 *              https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *   LM Studio  GET /api/v1/models -> `models[]` with `type` (llm | embedding), `key`, `size_bytes`,
 *              `capabilities.trained_for_tool_use`, `capabilities.reasoning`.
 *                                                        https://lmstudio.ai/docs/developer/rest/list
 *   anything   GET /v1/models -> `data[]`: a generic OpenAI-compatible server.
 *
 * Only GET requests, and `/api/show`, which reads. Nothing carries a key.
 */

import { aliasBaseUrl } from "../model-gateway/providers.js";
import { describeProbeFailure } from "./local-runtime.js";

export type RuntimeKind = "ollama" | "lmstudio" | "llama.cpp" | "openai-compatible";

export const RUNTIME_LABEL: Readonly<Record<RuntimeKind, string>> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "llama.cpp": "llama.cpp",
  "openai-compatible": "OpenAI-compatible server",
};

/** `cloud`: an Ollama cloud model, listed locally but run on ollama.com; never chosen by local setup. */
export type ModelRole = "chat" | "embedding" | "cloud";

export interface LocalModelInfo {
  readonly id: string;
  readonly sizeBytes?: number;
  readonly role: ModelRole;
  /** As the runtime reports them (`tools`, `thinking`, `embedding`, ...); absent when it reports none. */
  readonly capabilities?: readonly string[];
  readonly parameters?: string;
  readonly quantization?: string;
}

/** `default`: probed where the gateway would send calls; `base-url`: the URL the operator named. */
export type ProbeSource = "ollama" | "lmstudio" | "base-url";

export interface RuntimeFound {
  readonly reachable: true;
  readonly source: ProbeSource;
  readonly kind: RuntimeKind;
  /** The server root, without `/v1`. */
  readonly url: string;
  readonly version?: string;
  readonly contextTokens?: number;
  readonly slots?: number;
  readonly models: readonly LocalModelInfo[];
}

export interface RuntimeMissed {
  readonly reachable: false;
  readonly source: ProbeSource;
  readonly url: string;
  readonly error: string;
}

export type RuntimeProbe = RuntimeFound | RuntimeMissed;

export interface LocalDiscoveryPort {
  /** Ollama and LM Studio at the gateway's URLs, then `baseUrl` when given, in that order. */
  detect(input: { env: NodeJS.ProcessEnv; baseUrl?: string }): Promise<RuntimeProbe[]>;
  /** One Ollama model's capabilities from `/api/show`; undefined when they cannot be read. */
  capabilities(url: string, model: string): Promise<readonly string[] | undefined>;
}

export interface LocalDiscoveryDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 5_000;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/** `http://host:port/v1/` -> `http://host:port`: the native routes live at the server root. */
export function serverRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

const looksLikeEmbedder = (id: string): boolean => /embed/i.test(id);

function ollamaModel(entry: Json): LocalModelInfo | undefined {
  const id = String(entry.name ?? entry.model ?? "");
  if (id === "") return undefined;
  const capabilities = strings(entry.capabilities);
  const details = isObject(entry.details) ? entry.details : {};
  const cloud = typeof entry.remote_host === "string" || /[:-]cloud$/.test(id);
  const embedding = capabilities !== undefined ? capabilities.includes("embedding") && !capabilities.includes("completion") : looksLikeEmbedder(id);
  return {
    id,
    role: cloud ? "cloud" : embedding ? "embedding" : "chat",
    ...(positive(entry.size) === undefined || cloud ? {} : { sizeBytes: positive(entry.size) }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(typeof details.parameter_size === "string" ? { parameters: details.parameter_size } : {}),
    ...(typeof details.quantization_level === "string" ? { quantization: details.quantization_level } : {}),
  };
}

function lmStudioModel(entry: Json): LocalModelInfo | undefined {
  const id = String(entry.key ?? entry.id ?? "");
  if (id === "") return undefined;
  const caps = isObject(entry.capabilities) ? entry.capabilities : undefined;
  const capabilities = caps === undefined ? undefined : [...(caps.trained_for_tool_use === true ? ["tools"] : []), ...(caps.reasoning !== undefined ? ["thinking"] : [])];
  const quantization = isObject(entry.quantization) && typeof entry.quantization.name === "string" ? entry.quantization.name : undefined;
  return {
    id,
    role: entry.type === "embedding" || (entry.type === undefined && looksLikeEmbedder(id)) ? "embedding" : "chat",
    ...(positive(entry.size_bytes) === undefined ? {} : { sizeBytes: positive(entry.size_bytes) }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(typeof entry.params_string === "string" ? { parameters: entry.params_string } : {}),
    ...(quantization === undefined ? {} : { quantization }),
  };
}

function openAiModel(entry: Json): LocalModelInfo | undefined {
  const id = String(entry.id ?? "");
  if (id === "") return undefined;
  const size = isObject(entry.meta) ? positive(entry.meta.size) : undefined;
  return { id, role: looksLikeEmbedder(id) ? "embedding" : "chat", ...(size === undefined ? {} : { sizeBytes: size }) };
}

function listOf<T>(value: unknown, map: (entry: Json) => T | undefined): T[] {
  return (Array.isArray(value) ? value : []).filter(isObject).map(map).filter((m): m is T => m !== undefined);
}

export function createLocalDiscovery(deps: LocalDiscoveryDeps = {}): LocalDiscoveryPort {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** The parsed JSON of a 2xx answer, undefined for any other answer; throws only when nothing answers. */
  async function json(url: string, init: RequestInit = { method: "GET" }): Promise<Json | undefined> {
    const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    try {
      const body = (await response.json()) as unknown;
      return isObject(body) ? body : undefined;
    } catch {
      return undefined; // a 2xx that is not JSON is not one of the four runtimes
    }
  }

  async function identify(source: ProbeSource, url: string): Promise<RuntimeProbe> {
    try {
      const version = await json(`${url}/api/version`); // the first probe decides reachability
      if (typeof version?.version === "string") {
        const tags = await json(`${url}/api/tags`);
        return { reachable: true, source, kind: "ollama", url, version: version.version, models: listOf(tags?.models, ollamaModel) };
      }
      const props = await json(`${url}/props`);
      if (isObject(props?.default_generation_settings)) {
        const listing = await json(`${url}/v1/models`);
        const nCtx = positive(props!.default_generation_settings.n_ctx);
        const slots = positive(props!.total_slots);
        return {
          reachable: true, source, kind: "llama.cpp", url,
          ...(typeof props!.build_info === "string" ? { version: props!.build_info } : {}),
          ...(nCtx === undefined ? {} : { contextTokens: nCtx }),
          ...(slots === undefined ? {} : { slots }),
          models: listOf(listing?.data, openAiModel),
        };
      }
      const lmStudio = await json(`${url}/api/v1/models`);
      if (Array.isArray(lmStudio?.models)) return { reachable: true, source, kind: "lmstudio", url, models: listOf(lmStudio!.models, lmStudioModel) };
      const listing = await json(`${url}/v1/models`);
      if (Array.isArray(listing?.data)) return { reachable: true, source, kind: "openai-compatible", url, models: listOf(listing!.data, openAiModel) };
      return { reachable: false, source, url, error: "a server answered, but not as Ollama, llama.cpp, LM Studio or an OpenAI-compatible server" };
    } catch (error) {
      return { reachable: false, source, url, error: describeProbeFailure(error, timeoutMs) };
    }
  }

  return {
    async detect({ env, baseUrl }) {
      const targets: Array<[ProbeSource, string]> = [
        ["ollama", serverRoot(aliasBaseUrl("ollama", env))],
        ["lmstudio", serverRoot(aliasBaseUrl("lmstudio", env))],
      ];
      if (baseUrl !== undefined && baseUrl.trim() !== "") {
        const root = serverRoot(baseUrl);
        const same = targets.findIndex(([, url]) => url === root);
        if (same >= 0) targets.splice(same, 1); // one probe per server; the named URL wins its place
        targets.push(["base-url", root]);
      }
      return await Promise.all(targets.map(([source, url]) => identify(source, url)));
    },

    async capabilities(url, model) {
      try {
        const shown = await json(`${url}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) });
        return strings(shown?.capabilities);
      } catch {
        return undefined; // unreadable capabilities mean "unknown", which setup reports as such
      }
    },
  };
}
