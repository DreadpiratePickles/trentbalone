/**
 * [L0-3] Is the local runtime up, and what has it pulled?
 *
 * A local provider has no key, so "configured" means something else: the runtime answers and the
 * model is there. Setup (G3, G15), the REPL's degraded check (G7) and anything else that must tell
 * the truth about a local provider ask here. Endpoints, all on the operator's own machine:
 *
 *   Ollama     GET  <root>/api/version   {"version": "0.32.9"}
 *              GET  <root>/api/tags      {"models": [{"name": "qwen3.5:9b", ...}]}
 *              POST <root>/api/pull      NDJSON progress, ending {"status": "success"}
 *   LM Studio  GET  <base>/models        {"data": [{"id": "qwen/qwen3.5-9b"}, ...]}  (OpenAI shape)
 *
 * The base URL is the gateway's own (`model-gateway/providers.ts`: `OLLAMA_BASE_URL`,
 * `LMSTUDIO_BASE_URL`, else 127.0.0.1:11434 and :1234), so setup probes exactly where a run will
 * send its calls. No request carries a key, and nothing is sent anywhere but that URL.
 */

import { KEYLESS_ALIASES, PROVIDER_ALIAS_ROUTES, aliasBaseUrl } from "../model-gateway/providers.js";

export type LocalProvider = "ollama" | "lmstudio";

export function isLocalProvider(provider: string | undefined): provider is LocalProvider {
  return provider !== undefined && KEYLESS_ALIASES.has(provider) && (provider === "ollama" || provider === "lmstudio");
}

export interface LocalRuntimeUp {
  readonly reachable: true;
  readonly provider: LocalProvider;
  /** The runtime's root, as a person would paste it into a browser. */
  readonly url: string;
  readonly version?: string;
  /** Model ids the runtime can serve now, as it names them. */
  readonly models: readonly string[];
}

export interface LocalRuntimeDown {
  readonly reachable: false;
  readonly provider: LocalProvider;
  readonly url: string;
  /** Why, in a few words: `connection refused`, `HTTP 500`, `timed out after 3000ms`. */
  readonly error: string;
}

export type LocalRuntimeStatus = LocalRuntimeUp | LocalRuntimeDown;

export interface LocalRuntimePort {
  probe(provider: LocalProvider, env: NodeJS.ProcessEnv): Promise<LocalRuntimeStatus>;
  /** Ollama only. `progress` receives a line per stage; throws on a runtime error. */
  pull(model: string, env: NodeJS.ProcessEnv, progress: (line: string) => void): Promise<void>;
}

export const LOCAL_RUNTIME_LABEL: Readonly<Record<LocalProvider, string>> = {
  ollama: PROVIDER_ALIAS_ROUTES.ollama.label,
  lmstudio: PROVIDER_ALIAS_ROUTES.lmstudio.label,
};

/** The one command that starts the runtime. */
export const START_COMMAND: Readonly<Record<LocalProvider, string>> = {
  ollama: "ollama serve",
  lmstudio: "lms server start",
};

/** The exact line that fetches `model`, where the runtime has one. LM Studio downloads in its app. */
export function pullCommand(provider: LocalProvider, model: string): string | undefined {
  return provider === "ollama" ? `ollama pull ${model}` : undefined;
}

/** Where the runtime lives, without the OpenAI `/v1` suffix the gateway appends. */
export function runtimeRoot(provider: LocalProvider, env: NodeJS.ProcessEnv): string {
  return aliasBaseUrl(provider, env).replace(/\/v1$/, "");
}

/** True when `models` holds `model`; `name` and `name:latest` are the same Ollama model. */
export function hasLocalModel(models: readonly string[], model: string): boolean {
  const want = model.trim().replace(/:latest$/, "");
  return models.some((id) => id.trim().replace(/:latest$/, "") === want);
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** Why a probe got no answer, in a few words. [L2] exported for `local-detect.ts`. */
export function describeProbeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `timed out after ${timeoutMs}ms`;
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  if (cause !== undefined && cause.code === "ECONNREFUSED") return "connection refused";
  if (cause !== undefined && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

export interface LocalRuntimeDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createLocalRuntime(deps: LocalRuntimeDeps = {}): LocalRuntimePort {
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function getJson(url: string): Promise<unknown> {
    const response = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  }

  async function probeOllama(url: string): Promise<LocalRuntimeStatus> {
    const version = (await getJson(`${url}/api/version`)) as { version?: unknown };
    const tags = (await getJson(`${url}/api/tags`)) as { models?: Array<{ name?: unknown }> };
    const models = (tags.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
    return { reachable: true, provider: "ollama", url, ...(typeof version.version === "string" ? { version: version.version } : {}), models };
  }

  async function probeLmStudio(url: string): Promise<LocalRuntimeStatus> {
    const listing = (await getJson(`${url}/v1/models`)) as { data?: Array<{ id?: unknown }> };
    const models = (listing.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    return { reachable: true, provider: "lmstudio", url, models };
  }

  return {
    async probe(provider, env) {
      const url = runtimeRoot(provider, env);
      try {
        return provider === "ollama" ? await probeOllama(url) : await probeLmStudio(url);
      } catch (error) {
        return { reachable: false, provider, url, error: describeProbeFailure(error, timeoutMs) };
      }
    },

    async pull(model, env, progress) {
      const url = runtimeRoot("ollama", env);
      const response = await doFetch(`${url}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
      });
      if (!response.ok || response.body === null) throw new Error(`Ollama refused the pull of ${model}: HTTP ${response.status}`);
      await readPullStream(response.body, model, progress);
    },
  };
}

interface PullLine {
  status?: string;
  error?: string;
  total?: number;
  completed?: number;
}

/** One line per stage and per tenth of a layer, not one per chunk: a 6 GB pull is thousands. */
async function readPullStream(body: ReadableStream<Uint8Array>, model: string, progress: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  let lastStatus = "";
  let lastTenth = -1;
  let succeeded = false;

  const handle = (raw: string): void => {
    if (raw.trim() === "") return;
    const line = JSON.parse(raw) as PullLine;
    if (typeof line.error === "string") throw new Error(`Ollama could not pull ${model}: ${line.error}`);
    const status = line.status ?? "";
    if (status === "success") succeeded = true;
    const tenth = line.total && line.completed !== undefined ? Math.floor((line.completed / line.total) * 10) : -1;
    if (status !== lastStatus) {
      lastStatus = status;
      lastTenth = tenth;
      progress(`  ${status}`);
    } else if (tenth > lastTenth) {
      lastTenth = tenth;
      progress(`  ${status} ${tenth * 10}%`);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const raw of lines) handle(raw);
  }
  handle(buffered);
  if (!succeeded) throw new Error(`Ollama's pull of ${model} ended without "success"`);
}
