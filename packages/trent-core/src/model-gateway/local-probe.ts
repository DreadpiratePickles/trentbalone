/**
 * [L0-2] What a local runtime says about a model, read from its own endpoints (audit G17).
 *
 * THE WINDOW. The window a prompt must fit is the one the server LOADED the model with, not the
 * model's trained maximum: on this machine `/api/show` reports `qwen35.context_length: 262144` for
 * `qwen3.5:9b` while `/api/ps` reports the loaded model at `context_length: 32768` (Ollama 0.32.9,
 * read 2026-09-25), and Ollama's default is 4k under 24 GiB of VRAM, 32k to 48 GiB, 256k above
 * (https://docs.ollama.com/context-length). The OpenAI route cannot set it
 * (https://docs.ollama.com/api/openai-compatibility, "Setting the local context size"). In order:
 *   - Ollama `GET /api/ps`: the loaded model's `context_length`;
 *   - Ollama `POST /api/show`: a Modelfile `num_ctx` in `parameters`;
 *   - LM Studio `GET /api/v1/models`: `loaded_instances[].config.context_length`
 *     (https://lmstudio.ai/docs/developer/rest/list);
 *   - llama.cpp `GET /props`: `default_generation_settings.n_ctx`, the per-slot window (llama.cpp
 *     tools/server/README.md), for a llama-server placed behind either alias;
 *   - else `models.local.context_tokens`, capped by the trained maximum when a server named one.
 * A window the server reported is cached for the process; a fallback is not, so a model that loads
 * later is read then.
 *
 * CAPABILITIES. Ollama's `reasoning_effort` is model-defined: "Use /api/show to discover each model's
 * supported values" (openai-compatibility page). `capabilities` there lists `thinking` when the model
 * has it, which is when the gateway sends the field.
 */

import type { ProviderAlias } from "./providers.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ContextWindowSource =
  | "ollama /api/ps"
  | "ollama /api/show num_ctx"
  | "lmstudio /api/v1/models"
  | "llama.cpp /props"
  | "models.local.context_tokens";

export interface ContextWindow {
  readonly tokens: number;
  readonly source: ContextWindowSource;
}

export interface WindowProbeInput {
  readonly alias: ProviderAlias;
  /** The OpenAI-compatible base URL (`.../v1`); the native endpoints hang off its root. */
  readonly baseUrl: string;
  readonly model: string;
  /** `models.local.context_tokens`. */
  readonly fallbackTokens: number;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** A probe is a local metadata read: short, and never a reason to fail the call it serves. */
const PROBE_TIMEOUT_MS = 5_000;

const windows = new Map<string, ContextWindow>();
const shows = new Map<string, Promise<Record<string, unknown> | undefined>>();

/** Test seam: forget every cached probe. */
export function clearLocalProbeCache(): void {
  windows.clear();
  shows.clear();
}

/** `http://host:11434/v1` -> `http://host:11434`. */
function rootOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function readJson(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    // Unreachable, not this runtime, or not JSON: the next probe (or the fallback) answers.
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `llama3.2` and `llama3.2:latest` are one model to Ollama. */
function sameOllamaModel(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  const tagged = (name: string): string => (name.includes(":") ? name : `${name}:latest`);
  return tagged(a) === tagged(b);
}

function ollamaShow(fetchImpl: FetchLike, baseUrl: string, model: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  const key = `${rootOf(baseUrl)} ${model}`;
  const cached = shows.get(key);
  if (cached) return cached;
  const pending = readJson(fetchImpl, `${rootOf(baseUrl)}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) }, timeoutMs);
  shows.set(key, pending);
  void pending.then((body) => body === undefined && shows.delete(key));
  return pending;
}

/** The trained maximum a `/api/show` `model_info` names (`<arch>.context_length`), if any. */
function trainedMaximum(show: Record<string, unknown> | undefined): number | undefined {
  const info = show?.model_info;
  if (info === null || typeof info !== "object") return undefined;
  for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
    if (key.endsWith(".context_length") && count(value) !== undefined) return count(value);
  }
  return undefined;
}

async function probeOllama(fetchImpl: FetchLike, input: WindowProbeInput, timeoutMs: number): Promise<{ window?: ContextWindow; maximum?: number }> {
  const ps = await readJson(fetchImpl, `${rootOf(input.baseUrl)}/api/ps`, { method: "GET" }, timeoutMs);
  const loaded = Array.isArray(ps?.models) ? (ps.models as Array<Record<string, unknown>>) : [];
  const running = loaded.find((entry) => sameOllamaModel(entry.model, input.model) || sameOllamaModel(entry.name, input.model));
  const fromPs = count(running?.context_length);
  if (fromPs !== undefined) return { window: { tokens: fromPs, source: "ollama /api/ps" } };
  if (ps === undefined) return {};
  const show = await ollamaShow(fetchImpl, input.baseUrl, input.model, timeoutMs);
  const numCtx = typeof show?.parameters === "string" ? /^\s*num_ctx\s+(\d+)\s*$/m.exec(show.parameters)?.[1] : undefined;
  if (numCtx !== undefined && count(Number(numCtx)) !== undefined) return { window: { tokens: Number(numCtx), source: "ollama /api/show num_ctx" } };
  const maximum = trainedMaximum(show);
  return maximum === undefined ? {} : { maximum };
}

async function probeLmStudio(fetchImpl: FetchLike, input: WindowProbeInput, timeoutMs: number): Promise<{ window?: ContextWindow; maximum?: number }> {
  const list = await readJson(fetchImpl, `${rootOf(input.baseUrl)}/api/v1/models`, { method: "GET" }, timeoutMs);
  const models = Array.isArray(list?.models) ? (list.models as Array<Record<string, unknown>>) : [];
  const entry = models.find((m) => m.key === input.model || (Array.isArray(m.loaded_instances) && (m.loaded_instances as Array<Record<string, unknown>>).some((i) => i.id === input.model)));
  const instances = Array.isArray(entry?.loaded_instances) ? (entry.loaded_instances as Array<{ id?: unknown; config?: { context_length?: unknown } }>) : [];
  const instance = instances.find((i) => i.id === input.model) ?? instances[0];
  const loaded = count(instance?.config?.context_length);
  if (loaded !== undefined) return { window: { tokens: loaded, source: "lmstudio /api/v1/models" } };
  const maximum = count(entry?.max_context_length);
  return maximum === undefined ? {} : { maximum };
}

async function probeLlamaCpp(fetchImpl: FetchLike, input: WindowProbeInput, timeoutMs: number): Promise<ContextWindow | undefined> {
  const props = await readJson(fetchImpl, `${rootOf(input.baseUrl)}/props`, { method: "GET" }, timeoutMs);
  const settings = props?.default_generation_settings as { n_ctx?: unknown } | undefined;
  const nCtx = count(settings?.n_ctx);
  return nCtx === undefined ? undefined : { tokens: nCtx, source: "llama.cpp /props" };
}

/** The window a prompt to `model` must fit, and where that figure came from. */
export async function readContextWindow(input: WindowProbeInput): Promise<ContextWindow> {
  const key = `${input.alias} ${rootOf(input.baseUrl)} ${input.model}`;
  const cached = windows.get(key);
  if (cached) return cached;
  const fetchImpl = input.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const native = input.alias === "lmstudio" ? await probeLmStudio(fetchImpl, input, timeoutMs) : await probeOllama(fetchImpl, input, timeoutMs);
  const reported = native.window ?? (await probeLlamaCpp(fetchImpl, input, timeoutMs));
  if (reported !== undefined) {
    windows.set(key, reported);
    return reported;
  }
  const tokens = native.maximum === undefined ? input.fallbackTokens : Math.min(input.fallbackTokens, native.maximum);
  return { tokens, source: "models.local.context_tokens" };
}

/** Ollama's `/api/show` capabilities for `model`, or undefined when the server cannot be asked. */
export async function ollamaCapabilities(input: { baseUrl: string; model: string; fetchImpl?: FetchLike; timeoutMs?: number }): Promise<readonly string[] | undefined> {
  const fetchImpl = input.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const show = await ollamaShow(fetchImpl, input.baseUrl, input.model, input.timeoutMs ?? PROBE_TIMEOUT_MS);
  return Array.isArray(show?.capabilities) ? (show.capabilities as unknown[]).filter((c): c is string => typeof c === "string") : undefined;
}
