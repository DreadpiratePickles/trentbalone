/**
 * [L0-5] Local embedders (G9): Ollama, LM Studio and llama.cpp, on the operator's own machine.
 *
 * Before this, a local chat alias sent the OpenAI route's default model, `text-embedding-3-small`, to
 * the local runtime, which 404'd, and `lexical.ts` swallowed the 404 into lexical recall with no line
 * anywhere (local-path audit 2026-09-26, §5). A local route here names the runtime's OWN embedding
 * model and speaks its own endpoint:
 *
 * - Ollama: native `POST /api/embed` with `truncate: false`. The default is `true`, which cuts an
 *   over-long input silently (research §5.1 F1); with `false` it is an HTTP 400 ("the input length
 *   exceeds the context length", probed 2026-09-26), which is split around here, never cut.
 * - LM Studio and llama.cpp: `POST <base>/v1/embeddings`, the OpenAI dialect.
 *
 * A model's query and document prefixes (research §3: Qwen3-Embedding's instruction, nomic's
 * `search_query:`, EmbeddingGemma's `task: ...`) are its task types: applied when a call names roles,
 * cached per prefix through `embedder-cache.ts`. The cosine floor is per model: recorded below for the
 * models measured live (`embedder.live.test.ts`, the three fixed triples), and calibrated on first use
 * on the same triples for any other. A runtime that is down fails loudly ONCE (one WARN line with the
 * fix), recall falls back to lexical, and for a cooldown no further request is made.
 *
 * `applyAppEmbeddingEnv` is G10: the wrapped app's own embedding calls follow `memory.embedder`.
 */

import {
  DEFAULT_RETRY_POLICY,
  ProviderHttpError,
  classifyProviderError,
  resolveRetryPolicy,
  retryDelayMs,
  type RetryPolicy,
} from "../model-gateway/retry.js";
import { resolveProviderAlias } from "../model-gateway/providers.js";
import { StructuredLogger } from "../telemetry/logger.js";
import { CACHE_SEPARATOR, type EmbeddingCache } from "./embedder-cache.js";
import { HYBRID_VECTOR_FLOOR } from "./hybrid.js";
import { type CalibratedEmbedFn, type EmbedCallOptions, type EmbedFn, type EmbedRole } from "./lexical.js";
import { RECORDED_LOCAL_FLOORS, UNSEPARABLE_FLOOR, floorFromPairs, measureCalibration } from "./embedder-calibration.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type EmbedderWarn = (event: string, fields: Record<string, unknown>) => void;

export const LOCAL_EMBEDDER_PROVIDERS = ["ollama", "lmstudio", "llamacpp"] as const;
export type LocalEmbedderProvider = (typeof LOCAL_EMBEDDER_PROVIDERS)[number];

/** `dialect` ollama: native `/api/embed` at the server root; openai: `/embeddings` under a `/v1` base. */
export interface LocalEmbedderRoute {
  readonly provider: LocalEmbedderProvider;
  readonly label: string;
  readonly dialect: "ollama" | "openai";
  /** Moves the endpoint; `memory.embedder.base_url` wins over it. Ollama's is the chat alias's own. */
  readonly baseUrlEnv: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
}

export const LOCAL_EMBEDDER_ROUTES: Readonly<Record<LocalEmbedderProvider, LocalEmbedderRoute>> = {
  ollama: { provider: "ollama", label: "Ollama", dialect: "ollama", baseUrlEnv: "OLLAMA_BASE_URL", defaultBaseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3-embedding:0.6b" },
  lmstudio: { provider: "lmstudio", label: "LM Studio", dialect: "openai", baseUrlEnv: "LMSTUDIO_BASE_URL", defaultBaseUrl: "http://127.0.0.1:1234/v1", defaultModel: "text-embedding-qwen3-embedding-0.6b" },
  llamacpp: { provider: "llamacpp", label: "llama.cpp", dialect: "openai", baseUrlEnv: "LLAMACPP_BASE_URL", defaultBaseUrl: "http://127.0.0.1:8080/v1", defaultModel: "qwen3-embedding-0.6b" },
};

export function isLocalEmbedderProvider(value: string | undefined): value is LocalEmbedderProvider {
  return value !== undefined && (LOCAL_EMBEDDER_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The local runtime an embedder setting resolves to: a runtime named outright, or — for `auto`, and for
 * `openai`, whose route under a local alias was exactly the 404 above — the runtime a local chat alias
 * already points at. A local chat provider never implies a hosted embedder: the recall corpus stays home.
 */
export function localRouteFor(setting: string, chatProvider: string | undefined): LocalEmbedderProvider | undefined {
  if (isLocalEmbedderProvider(setting)) return setting;
  if (setting !== "auto" && setting !== "openai") return undefined;
  const alias = resolveProviderAlias(chatProvider?.trim().toLowerCase());
  return alias?.local === true && isLocalEmbedderProvider(alias.alias) ? alias.alias : undefined;
}

/** The base a route's requests go to: Ollama's server root (its alias URL ends in `/v1`), else a `/v1` base. */
export function localBaseUrl(provider: LocalEmbedderProvider, configured: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const route = LOCAL_EMBEDDER_ROUTES[provider];
  const fromEnv = env[route.baseUrlEnv]?.trim();
  const raw = (configured?.trim() || fromEnv || route.defaultBaseUrl).replace(/\/+$/, "");
  if (route.dialect === "ollama") return raw.replace(/\/v1$/, "");
  return raw.endsWith("/v1") ? raw : `${raw}/v1`;
}

/** The OpenAI-compatible base on the same server: what the app's client would have to be pointed at. */
export function openAiBaseOf(provider: LocalEmbedderProvider, baseUrl: string): string {
  return LOCAL_EMBEDDER_ROUTES[provider].dialect === "ollama" ? `${baseUrl}/v1` : baseUrl;
}

// ── Models: prefixes, dimensions, recorded floors ───────────────────────────────────────────────

/** The prefixes (research §3) put before a text embedded as the question, or as a document that may answer it. */
export interface LocalModelProfile {
  readonly family: string;
  readonly queryPrefix?: string;
  readonly documentPrefix?: string;
}

const FAMILIES: ReadonlyArray<LocalModelProfile & { readonly match: RegExp }> = [
  // Qwen3-Embedding: instruction on the query only, `Instruct: {task}\nQuery:{q}` (model card).
  { match: /qwen3-embedding/, family: "qwen3-embedding", queryPrefix: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:" },
  { match: /nomic-embed-text/, family: "nomic-embed-text", queryPrefix: "search_query: ", documentPrefix: "search_document: " },
  { match: /embeddinggemma/, family: "embeddinggemma", queryPrefix: "task: search result | query: ", documentPrefix: "title: none | text: " },
  { match: /mxbai-embed-large/, family: "mxbai-embed-large", queryPrefix: "Represent this sentence for searching relevant passages: " },
];

const KNOWN_DIMS: Readonly<Record<string, number>> = {
  "qwen3-embedding:0.6b": 1024, "qwen3-embedding:4b": 2560, "qwen3-embedding:8b": 4096,
  "nomic-embed-text": 768, "embeddinggemma": 768, "mxbai-embed-large": 1024, "bge-m3": 1024,
};

/** `qwen3-embedding:0.6b` and `qwen3-embedding:0.6b` written with `:latest` or upper case are one model. */
export function normaliseLocalModel(model: string): string {
  return model.trim().toLowerCase().replace(/:latest$/, "");
}

export function localModelProfile(model: string): LocalModelProfile {
  const name = normaliseLocalModel(model);
  const found = FAMILIES.find((f) => f.match.test(name));
  if (found === undefined) return { family: name };
  const { match: _match, ...profile } = found;
  return profile;
}

/** Dimensions a model is published with; 0 when unknown (the doctor reports the measured count). */
export function localModelDims(model: string): number {
  return KNOWN_DIMS[normaliseLocalModel(model)] ?? 0;
}

// ── HTTP, shared with the hosted routes in `embedder.ts` ───────────────────────────────────────

export async function fetchWithDeadline(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    // A bare AbortError classifies as `internal` and is never retried; name it so it classifies.
    const timeout = new Error(`embedding request exceeded ${timeoutMs}ms`);
    timeout.name = "TimeoutError";
    throw timeout;
  } finally {
    clearTimeout(timer);
  }
}

/** `label` names the provider in a `ProviderHttpError` (never a key); an `isFinal` failure is not retried. */
export interface PostJsonInput<T> {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly parse: (payload: unknown) => T;
  readonly label: string;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchLike;
  readonly policy: RetryPolicy;
  readonly sleep: (ms: number) => Promise<void>;
  readonly isFinal?: (error: unknown) => boolean;
}

/** One JSON POST under the gateway's bounded retry policy; a non-2xx is a `ProviderHttpError`. */
export async function postJsonWithRetry<T>(input: PostJsonInput<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const init = { method: "POST", headers: { ...input.headers, "content-type": "application/json" }, body: JSON.stringify(input.body) };
      const response = await fetchWithDeadline(input.url, init, input.timeoutMs, input.fetchImpl);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ProviderHttpError({ provider: input.label, status: response.status, statusText: response.statusText, headers: response.headers, body });
      }
      return input.parse(await response.json());
    } catch (error) {
      const classified = classifyProviderError(error);
      if (input.isFinal?.(error) === true || !classified.retryable || attempt >= input.policy.attempts) throw error;
      await input.sleep(retryDelayMs({ attempt, policy: input.policy, ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }) }));
    }
  }
}

function numbers(row: unknown): number[] {
  if (!Array.isArray(row) || row.length === 0) throw new Error("embedding response carried a row with no vector");
  return row.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
}

/** OpenAI's `{data: [{index, embedding}]}`, placed by index. A short answer is an error, never a misalignment. */
export function parseOpenAiEmbeddings(payload: unknown, expected: number): number[][] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`embedding response carried ${Array.isArray(data) ? data.length : 0} vectors, expected ${expected}`);
  }
  const out = new Array<number[]>(expected);
  data.forEach((raw, i) => {
    const row = raw as { index?: unknown; embedding?: unknown };
    const at = typeof row?.index === "number" && row.index >= 0 && row.index < expected ? row.index : i;
    out[at] = numbers(row?.embedding);
  });
  return out;
}

/** Ollama's `{embeddings: [[...]]}`, in input order. */
export function parseOllamaEmbeddings(payload: unknown, expected: number): number[][] {
  const rows = (payload as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new Error(`embedding response carried ${Array.isArray(rows) ? rows.length : 0} vectors, expected ${expected}`);
  }
  return rows.map(numbers);
}

// ── The embedder ────────────────────────────────────────────────────────────────────────────────

const OVER_LENGTH = /input length exceeds|exceeds the context|context length|too large to process|input is too (long|large)|maximum context/i;
const MODEL_MISSING = /not found|no such model|model .*not (loaded|available)|try pulling/i;
/** Splits of one input before giving up: 2^6 = 64 pieces. */
const MAX_SPLIT_DEPTH = 6;
const MIN_SPLIT_CHARS = 16;
export const LOCAL_EMBEDDER_COOLDOWN_MS = 60_000;
/**
 * A local runtime's deadline. A cold load of the 0.6B model took 4.7 s on an idle M1 Max, and one input
 * took 28 s while another agent's 9B chat model held the same Ollama (2026-09-26): the hosted 20 s is too short.
 */
export const LOCAL_EMBED_TIMEOUT_MS = 120_000;

/** The runtime refused an input for its length: split around, never an outage. */
export function isOverLength(error: unknown): boolean {
  return error instanceof ProviderHttpError && [400, 413, 500].includes(error.status) && OVER_LENGTH.test(error.message);
}

export class LocalEmbedderUnavailableError extends Error {
  constructor(message: string, readonly reason: "model_missing" | "unreachable" | "rejected", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalEmbedderUnavailableError";
  }
}

export interface LocalEmbedderSelection { readonly provider: LocalEmbedderProvider; readonly label: string; readonly model: string; readonly baseUrl: string; readonly batchSize: number }

export interface LocalEmbedOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly cache?: EmbeddingCache;
  /** `false` ignores a call's roles (no prefixes). Default on: the prefixes are the model's documented use. */
  readonly taskTypes?: boolean;
  /** Where the one line per outage goes. Default: a structured WARN on stderr. */
  readonly warn?: EmbedderWarn;
  readonly now?: () => number;
  readonly cooldownMs?: number;
}

export interface LocalEmbedder { readonly embed: CalibratedEmbedFn; readonly dims: number; readonly taskTypes: boolean }

/** What to do about an outage, in the runtime's own words. */
export function localFixHint(provider: LocalEmbedderProvider, model: string, reason: "model_missing" | "unreachable" | "rejected"): string {
  if (reason === "model_missing") {
    if (provider === "ollama") return `ollama pull ${model}`;
    return provider === "lmstudio" ? `load ${model} in LM Studio (lms load ${model})` : `start llama-server with that model: llama-server --embedding --pooling last -m <${model}.gguf>`;
  }
  if (reason === "rejected") return `set memory.embedder.model to an embedding model ${LOCAL_EMBEDDER_ROUTES[provider].label} serves`;
  if (provider === "ollama") return "start Ollama (ollama serve), or set memory.embedder.base_url";
  return provider === "lmstudio" ? "start LM Studio's server (lms server start), or set memory.embedder.base_url" : "start llama-server --embedding, or set memory.embedder.base_url";
}

function failureReason(error: unknown): "model_missing" | "unreachable" | "rejected" {
  if (!(error instanceof ProviderHttpError)) return error instanceof Error && /^embedding response/.test(error.message) ? "rejected" : "unreachable";
  if (error.status === 404 || MODEL_MISSING.test(error.message)) return "model_missing";
  return error.status >= 500 || error.status === 408 || error.status === 429 ? "unreachable" : "rejected";
}

function unit(v: readonly number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** The normalised mean of the pieces' unit vectors: one vector for a text embedded in parts. */
function meanUnit(vectors: readonly number[][]): number[] {
  const sum = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const v of vectors.map(unit)) v.forEach((x, i) => (sum[i] = sum[i]! + x));
  return unit(sum);
}

/** Two halves cut at the whitespace nearest the middle; undefined when there is nothing left to cut. */
function splitInHalf(text: string): [string, string] | undefined {
  if (text.length < MIN_SPLIT_CHARS) return undefined;
  const middle = Math.floor(text.length / 2);
  let cut = middle;
  for (let d = 0; d < middle; d += 1) {
    if (/\s/.test(text[middle - d] ?? "")) { cut = middle - d; break; }
    if (/\s/.test(text[middle + d] ?? "")) { cut = middle + d; break; }
  }
  const left = text.slice(0, cut).trim();
  const right = text.slice(cut).trim();
  return left !== "" && right !== "" ? [left, right] : undefined;
}

interface Entry { readonly text: string; readonly prefix: string }

let defaultLogger: StructuredLogger | undefined;
const defaultWarn: EmbedderWarn = (event, fields) => (defaultLogger ??= new StructuredLogger({ runId: "embedder" })).warn(event, fields);

export function createLocalEmbedder(selection: LocalEmbedderSelection, options: LocalEmbedOptions): LocalEmbedder {
  const route = LOCAL_EMBEDDER_ROUTES[selection.provider];
  const profile = localModelProfile(selection.model);
  const honoured = options.taskTypes !== false && (profile.queryPrefix !== undefined || profile.documentPrefix !== undefined);
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const policy = resolveRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const warn = options.warn ?? defaultWarn;
  const clock = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? LOCAL_EMBEDDER_COOLDOWN_MS;
  const recorded = RECORDED_LOCAL_FLOORS[normaliseLocalModel(selection.model)];
  let floors: { vector: number; query: number } | undefined = recorded === undefined ? undefined : { vector: recorded.vectorFloor, query: recorded.queryFloor };
  let calibrating: Promise<void> | undefined;
  let downUntil = 0;
  let warned = false;

  const request = (inputs: string[]): Promise<number[][]> => postJsonWithRetry({
    url: route.dialect === "ollama" ? `${selection.baseUrl}/api/embed` : `${selection.baseUrl}/embeddings`,
    headers: {},
    body: route.dialect === "ollama" ? { model: selection.model, input: inputs, truncate: false } : { model: selection.model, input: inputs },
    parse: (payload) => (route.dialect === "ollama" ? parseOllamaEmbeddings : parseOpenAiEmbeddings)(payload, inputs.length),
    label: route.label,
    timeoutMs: options.timeoutMs,
    fetchImpl,
    policy,
    sleep,
    isFinal: isOverLength,
  });

  /** A batch the runtime refuses for length is retried one input at a time; one input is halved until it fits. */
  async function embedEntries(entries: readonly Entry[], depth: number): Promise<number[][]> {
    try {
      return await request(entries.map((e) => e.prefix + e.text));
    } catch (error) {
      if (!isOverLength(error)) throw error;
      if (entries.length > 1) {
        const out: number[][] = [];
        for (const entry of entries) out.push(...(await embedEntries([entry], depth)));
        return out;
      }
      const only = entries[0]!;
      const halves = depth >= MAX_SPLIT_DEPTH ? undefined : splitInHalf(only.text);
      if (halves === undefined) throw error;
      return [meanUnit(await embedEntries(halves.map((text) => ({ text, prefix: only.prefix })), depth + 1))];
    }
  }

  const prefixOf = (role: EmbedRole | undefined): string => {
    if (!honoured || role === undefined) return "";
    return (role === "query" ? profile.queryPrefix : profile.documentPrefix) ?? "";
  };

  /** Cache, dedupe by (prefix, text), bounded batches. */
  const raw: EmbedFn = async (texts, call?: EmbedCallOptions) => {
    const out = new Array<number[]>(texts.length).fill([]);
    const pending = new Map<string, Entry & { slots: number[] }>();
    texts.forEach((text, index) => {
      if (text.trim() === "") return;
      const prefix = prefixOf(call?.roles?.[index]);
      const taskType = prefix === "" ? undefined : prefix;
      const hit = options.cache?.read(selection.model, text, taskType);
      if (hit !== undefined) {
        out[index] = hit;
        return;
      }
      const key = `${prefix}${CACHE_SEPARATOR}${text}`;
      const entry = pending.get(key);
      if (entry === undefined) pending.set(key, { text, prefix, slots: [index] });
      else entry.slots.push(index);
    });
    const entries = [...pending.values()];
    for (let start = 0; start < entries.length; start += selection.batchSize) {
      const batch = entries.slice(start, start + selection.batchSize);
      const vectors = await embedEntries(batch, 0);
      batch.forEach((entry, i) => {
        const vector = vectors[i] ?? [];
        options.cache?.write(selection.model, entry.text, vector, entry.prefix === "" ? undefined : entry.prefix);
        for (const slot of entry.slots) out[slot] = vector;
      });
    }
    return out;
  };

  /** A model with no recorded floor is calibrated once, on the three fixed triples, before its first answer. */
  async function ensureFloors(): Promise<void> {
    if (floors !== undefined) return;
    calibrating ??= (async () => {
      const vector = floorFromPairs(await measureCalibration(raw, false));
      const query = honoured ? floorFromPairs(await measureCalibration(raw, true)) : vector;
      floors = { vector: vector ?? UNSEPARABLE_FLOOR, query: query ?? UNSEPARABLE_FLOOR };
      if (vector === undefined || query === undefined) {
        warn("embedder.local_uncalibrated", { provider: selection.provider, model: selection.model, floor: UNSEPARABLE_FLOOR, effect: "the model cannot tell a paraphrase from an unrelated sentence, so its vectors earn no credit and recall is lexical" });
      }
    })().finally(() => {
      calibrating = undefined;
    });
    await calibrating;
  }

  const embed = async (texts: readonly string[], call?: EmbedCallOptions): Promise<number[][]> => {
    if (clock() < downUntil) {
      throw new LocalEmbedderUnavailableError(`${route.label} embeddings are paused after a failure at ${selection.baseUrl}; recall is lexical until ${new Date(downUntil).toISOString()}`, "unreachable");
    }
    try {
      await ensureFloors();
      const vectors = await raw(texts, call);
      warned = false;
      return vectors;
    } catch (error) {
      if (isOverLength(error)) throw error;
      const reason = failureReason(error);
      const cause = error instanceof Error ? error.message : String(error);
      downUntil = clock() + cooldownMs;
      if (!warned) {
        warned = true;
        warn("embedder.local_unavailable", { provider: selection.provider, model: selection.model, endpoint: selection.baseUrl, reason, cause, fix: localFixHint(selection.provider, selection.model, reason), fallback: "lexical", retry_after_ms: cooldownMs });
      }
      throw new LocalEmbedderUnavailableError(`${route.label} embeddings unavailable at ${selection.baseUrl} (${reason}): ${cause}`, reason, { cause: error });
    }
  };

  // The floors ride on the function (lexical.ts reads them after the call), so a calibrated value is live.
  Object.defineProperty(embed, "vectorFloor", { enumerable: true, get: () => floors?.vector ?? HYBRID_VECTOR_FLOOR });
  Object.defineProperty(embed, "queryFloor", { enumerable: true, get: () => (honoured ? floors?.query ?? HYBRID_VECTOR_FLOOR : undefined) });
  return { embed: embed as CalibratedEmbedFn, dims: localModelDims(selection.model), taskTypes: honoured };
}

// ── G10: the wrapped app's own embedding calls ──────────────────────────────────────────────────

export const APP_EMBEDDING_MODEL_ENV = "EMBEDDING_MODEL";

export interface AppEmbeddingEnvSource {
  readonly provider?: string;
  readonly memory?: { readonly embedder?: { readonly provider?: string; readonly model?: string; readonly base_url?: string } };
}

/** Variable names only, never values. */
export interface AppEmbeddingEnvReport {
  readonly written: string[];
  readonly kept: string[];
  readonly reason: "local_model" | "none" | "not_local" | "other_endpoint" | "no_embedder_config";
}

/**
 * `apps/web/lib/wiki-embeddings.ts:20` and `semantic-router.ts:14` read `EMBEDDING_MODEL` once, at load,
 * and send it to `OPENAI_BASE_URL` whenever `OPENAI_API_KEY` is set. Under a local alias that base URL is
 * the local runtime, so the default `text-embedding-3-small` was a 404 on every step. When the profile's
 * embedder is a local model on that SAME runtime, the app is pointed at it; an operator's value wins.
 * Call after the alias env is written and before either app module loads (`applyModelEnv`).
 *
 * Under `none` nothing is written, because nothing here can switch those calls off: `OPENAI_API_KEY` is
 * their only off switch and the app's OpenAI chat client needs the same variable.
 */
export function applyAppEmbeddingEnv(config: AppEmbeddingEnvSource, env: NodeJS.ProcessEnv = process.env): AppEmbeddingEnvReport {
  const settings = config.memory?.embedder;
  if (settings === undefined) return { written: [], kept: [], reason: "no_embedder_config" };
  const setting = settings.provider?.trim().toLowerCase() || "auto";
  if (setting === "none") return { written: [], kept: [], reason: "none" };
  const provider = localRouteFor(setting, config.provider);
  if (provider === undefined) return { written: [], kept: [], reason: "not_local" };
  const target = openAiBaseOf(provider, localBaseUrl(provider, settings.base_url, env));
  if ((env.OPENAI_BASE_URL ?? "").trim().replace(/\/+$/, "") !== target) return { written: [], kept: [], reason: "other_endpoint" };
  if ((env[APP_EMBEDDING_MODEL_ENV] ?? "").trim() !== "") return { written: [], kept: [APP_EMBEDDING_MODEL_ENV], reason: "local_model" };
  env[APP_EMBEDDING_MODEL_ENV] = settings.model?.trim() || LOCAL_EMBEDDER_ROUTES[provider].defaultModel;
  return { written: [APP_EMBEDDING_MODEL_ENV], kept: [], reason: "local_model" };
}
