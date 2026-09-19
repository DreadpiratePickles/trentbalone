/**
 * The core embedder (C3): real vectors behind the `EmbedFn` seam `lexical.ts` has always had.
 *
 * Until now nothing ever passed `embed:`, so fleet recall was TF-IDF and only TF-IDF (fleet-brain
 * audit 3.2). The repository's only vector search, `apps/web/lib/wiki-embeddings.ts`, is
 * module-private, wiki-scoped, and returns HASH vectors without `OPENAI_API_KEY` — not a fallback,
 * a different answer that looks like one. So the embedder is built here in the wrapper, on the
 * provider the operator already pays for (design review section 5 option iii; plan decision 7).
 *
 * One OpenAI-dialect `POST /embeddings` serves BOTH providers: Google publishes an
 * OpenAI-compatible surface at `/v1beta/openai` and that is what the existing key is proven on.
 * The four OpenAI-dialect aliases are resolved by `model-gateway/providers.ts`, not re-listed
 * here. Batches are bounded by `memory.embedder.batch_size`, retries are the gateway's bounded
 * policy, every request carries a deadline, and a content-addressed cache under
 * `<profileDir>/cache/embeddings/` (0700) means an unchanged run window re-embeds nothing. No key
 * is ever logged, thrown, cached or put in a details bag. With no key the embedder resolves to
 * `none` and `embedderForProfile` returns `undefined`, so recall stays what it was.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_RETRY_POLICY,
  ProviderHttpError,
  classifyProviderError,
  resolveRetryPolicy,
  retryDelayMs,
  type RetryPolicy,
} from "../model-gateway/retry.js";
import { LOCAL_PLACEHOLDER_KEY, aliasBaseUrl, resolveProviderAlias } from "../model-gateway/providers.js";
import { lexicalEmbedFn, type CalibratedEmbedFn, type EmbedFn } from "./lexical.js";

/** What ranks the recall. `none` is lexical TF-IDF alone. `auto` is the first provider with a key. */
export type EmbedderProvider = "gemini" | "openai" | "none";
export type EmbedderProviderSetting = "auto" | EmbedderProvider;

/** The `memory.embedder` config block, as a plain shape so this module needs no zod import. */
export interface EmbedderSettings {
  readonly provider?: EmbedderProviderSetting;
  readonly model?: string;
  readonly batch_size?: number;
}

/** Structural view of `TrentConfig`: only the two fields the selection reads. */
export interface EmbedderConfigSource {
  readonly provider?: string;
  readonly memory?: { readonly embedder?: EmbedderSettings };
}

export type SecretLookup = Readonly<Record<string, string | undefined>>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface EmbedderRoute {
  readonly provider: "gemini" | "openai";
  readonly label: string;
  /** Moves the endpoint without a code change (a proxy, a mirror, a regional host). */
  readonly baseUrlEnv: string;
  readonly defaultBaseUrl: string;
  /** Accepted variable names, most specific first. Values are read, never returned or logged. */
  readonly apiKeyEnvs: readonly string[];
  readonly defaultModel: string;
  /** Dimensions the default model returns; the doctor reports the MEASURED count, not this one. */
  readonly defaultDims: number;
  /** Cosine at or below which THIS model's vectors mean "unrelated" (`hybrid.ts`). Per model. */
  readonly vectorFloor: number;
}

export const EMBEDDER_ROUTES: Readonly<Record<"gemini" | "openai", EmbedderRoute>> = {
  gemini: {
    provider: "gemini",
    label: "Google Gemini",
    baseUrlEnv: "GEMINI_BASE_URL",
    // Google's OpenAI-compatible surface. The native `:embedContent` endpoint speaks a different
    // dialect; this one takes the same body as OpenAI and is what the existing key is proven on.
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnvs: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    defaultModel: "gemini-embedding-001",
    defaultDims: 3072,
    // Measured by `embedder.live.test.ts`: unrelated 0.529, paraphrase 0.754 against the same
    // objective. 0.60 sits between them with margin. Calibration, not a constant of nature —
    // Google's space is anisotropic and the live proof re-checks it on every run.
    vectorFloor: 0.6,
  },
  openai: {
    provider: "openai",
    label: "OpenAI",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnvs: ["OPENAI_API_KEY"],
    defaultModel: "text-embedding-3-small",
    defaultDims: 1536,
    // Not measured here (no OpenAI key on this machine). OpenAI's v3 space is far less
    // anisotropic than Google's, so the floor is lower; the live proof measures whichever key
    // is present and prints both figures.
    vectorFloor: 0.3,
  },
};

/** Auto order when the configured chat provider does not itself name an embedding route. */
const AUTO_ORDER: ReadonlyArray<"gemini" | "openai"> = ["gemini", "openai"];

export const DEFAULT_EMBED_BATCH_SIZE = 32;
export const MAX_EMBED_BATCH_SIZE = 256;
/** One input is truncated here; embedding models refuse a long document outright. */
export const MAX_EMBED_INPUT_CHARS = 8_000;
export const DEFAULT_EMBED_TIMEOUT_MS = 20_000;
/** Cache-key field separator, so "ab"+"c" and "a"+"bc" cannot hash alike. */
const SEPARATOR = "\u0000";
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/** Why the selection landed where it did, so the doctor can say something true about it. */
export type EmbedderReason = "configured" | "disabled" | "no_key";

export interface EmbedderSelection {
  readonly provider: EmbedderProvider;
  readonly label: string;
  /** "" when the provider is `none`. */
  readonly model: string;
  /** What the DEFAULT model returns; 0 for a model we have not measured. */
  readonly dims: number;
  readonly batchSize: number;
  readonly baseUrl: string;
  /** The route's unrelated-text baseline, carried through to the blend. */
  readonly vectorFloor: number;
  /** The NAME of the variable the key was found in. Never the value. */
  readonly apiKeyEnv?: string;
  readonly reason: EmbedderReason;
}

export interface Embedder {
  readonly embed: EmbedFn;
  readonly provider: EmbedderProvider;
  readonly model: string;
  readonly dims: number;
}

export interface CreateEmbedderOptions {
  /** `<profileDir>/cache/embeddings/` is the cache. Omitted, nothing is cached. */
  readonly profileDir?: string;
  readonly env?: SecretLookup;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  /** Injected so a backoff is asserted, never waited for. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The doctor turns the cache off: a cached probe proves nothing about the key today. */
  readonly useCache?: boolean;
}

function envValue(source: SecretLookup, name: string): string | undefined {
  const raw = source[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** Secrets file first, process environment second — the same order the doctor's check uses. */
function findKey(
  names: readonly string[],
  secrets: SecretLookup,
  env: SecretLookup,
): { envVar: string; value: string } | undefined {
  for (const name of names) {
    const value = envValue(secrets, name) ?? envValue(env, name);
    if (value !== undefined) return { envVar: name, value };
  }
  return undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A route with its base URL already resolved. `local` means no account and no key is needed. */
type Endpoint = Omit<EmbedderRoute, "baseUrlEnv" | "defaultBaseUrl"> & { baseUrl: string; local: boolean };

/**
 * The concrete endpoint for one route, with `model-gateway/providers.ts` deciding the base URL and
 * the key variable whenever the chat provider is one of its four aliases — that module is the one
 * place those endpoints are written down.
 */
function endpointFor(
  route: "gemini" | "openai",
  config: EmbedderConfigSource,
  env: SecretLookup,
): Endpoint {
  const { baseUrlEnv, defaultBaseUrl, ...base } = EMBEDDER_ROUTES[route];
  const alias = route === "openai" ? resolveProviderAlias(config.provider) : undefined;
  if (alias !== undefined) {
    return {
      ...base,
      provider: "openai",
      label: alias.label,
      baseUrl: trimTrailingSlash(aliasBaseUrl(alias.alias, env as NodeJS.ProcessEnv)),
      apiKeyEnvs: [alias.apiKeyEnv],
      local: alias.local,
    };
  }
  return {
    ...base,
    baseUrl: trimTrailingSlash(envValue(env, baseUrlEnv) ?? defaultBaseUrl),
    local: false,
  };
}

/** The embedding route the configured CHAT provider implies, when it implies one. */
function preferredRoute(provider: string | undefined): "gemini" | "openai" | undefined {
  if (provider === undefined) return undefined;
  const name = provider.trim().toLowerCase();
  if (name === "google") return "gemini";
  if (name === "openai" || resolveProviderAlias(name) !== undefined) return "openai";
  return undefined;
}

function boundedBatchSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return DEFAULT_EMBED_BATCH_SIZE;
  return Math.min(MAX_EMBED_BATCH_SIZE, Math.floor(value));
}

const LEXICAL_ONLY = { provider: "none", label: "", model: "", dims: 0, baseUrl: "", vectorFloor: 0 } as const;

/**
 * Which embedder this machine will run, without reading a key value out to the caller. `auto`
 * prefers the provider the operator already routes chat through, then the shipped order; a named
 * provider with no key resolves to `none`, not to a request that cannot succeed.
 */
export function selectEmbedderProvider(
  config: EmbedderConfigSource,
  secrets: SecretLookup,
  env: SecretLookup = process.env,
): EmbedderSelection {
  const settings = config.memory?.embedder ?? {};
  const batchSize = boundedBatchSize(settings.batch_size);
  const setting = settings.provider ?? "auto";
  if (setting === "none") return { ...LEXICAL_ONLY, batchSize, reason: "disabled" };

  const preferred = preferredRoute(config.provider);
  const order: ReadonlyArray<"gemini" | "openai"> =
    setting === "auto"
      ? [...(preferred === undefined ? [] : [preferred]), ...AUTO_ORDER.filter((r) => r !== preferred)]
      : [setting];

  for (const route of order) {
    const endpoint = endpointFor(route, config, env);
    const found = findKey(endpoint.apiKeyEnvs, secrets, env);
    if (found === undefined && !endpoint.local) continue;
    const model = settings.model?.trim() || endpoint.defaultModel;
    return {
      provider: endpoint.provider,
      label: endpoint.label,
      model,
      dims: model === endpoint.defaultModel ? endpoint.defaultDims : 0,
      batchSize,
      baseUrl: endpoint.baseUrl,
      vectorFloor: endpoint.vectorFloor,
      ...(found === undefined ? {} : { apiKeyEnv: found.envVar }),
      reason: "configured",
    };
  }
  return { ...LEXICAL_ONLY, batchSize, reason: "no_key" };
}

/**
 * sha256 over the endpoint, the model AND the text. Model plus text is the minimum (a model change
 * must be a miss); the endpoint joins them because one model NAME on two hosts is two spaces.
 */
function cacheKey(scope: string, model: string, text: string): string {
  const hash = createHash("sha256");
  for (const part of [scope, model, text]) hash.update(part).update(SEPARATOR);
  return hash.digest("hex");
}

function encodeVector(vector: readonly number[]): string {
  return Buffer.from(Float32Array.from(vector).buffer).toString("base64");
}

function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}

/** The disk half of the embedder. Every failure here is a cache miss, never a run failure. */
class EmbeddingCache {
  readonly #dir: string;
  readonly #scope: string;

  constructor(profileDir: string, scope: string) {
    this.#dir = path.join(profileDir, "cache", "embeddings");
    this.#scope = scope;
  }

  read(model: string, text: string): number[] | undefined {
    try {
      const raw = fs.readFileSync(this.#fileFor(model, text), "utf8");
      const parsed = JSON.parse(raw) as { model?: unknown; vector?: unknown };
      if (parsed.model !== model || typeof parsed.vector !== "string") return undefined;
      return decodeVector(parsed.vector);
    } catch {
      return undefined;
    }
  }

  write(model: string, text: string, vector: readonly number[]): void {
    const file = this.#fileFor(model, text);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: CACHE_DIR_MODE });
      fs.chmodSync(this.#dir, CACHE_DIR_MODE);
      fs.writeFileSync(
        file,
        JSON.stringify({ model, dims: vector.length, vector: encodeVector(vector) }),
        { mode: CACHE_FILE_MODE },
      );
    } catch {
      /* a cache that cannot be written is still a working embedder */
    }
  }

  // Two hex characters of fan-out: one flat directory would hold every step ever recalled.
  #fileFor(model: string, text: string): string {
    const key = cacheKey(this.#scope, model, text);
    return path.join(this.#dir, key.slice(0, 2), `${key}.json`);
  }
}

function parseEmbeddings(payload: unknown, expected: number): number[][] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== expected) {
    throw new Error(`embedding response carried ${Array.isArray(data) ? data.length : 0} vectors, expected ${expected}`);
  }
  const out: number[][] = new Array<number[]>(expected);
  for (let i = 0; i < data.length; i += 1) {
    const row = data[i] as { index?: unknown; embedding?: unknown };
    const at = typeof row?.index === "number" && row.index >= 0 && row.index < expected ? row.index : i;
    if (!Array.isArray(row?.embedding) || row.embedding.length === 0) {
      throw new Error("embedding response carried a row with no vector");
    }
    out[at] = (row.embedding as unknown[]).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  }
  return out;
}

async function fetchWithDeadline(url: string, init: RequestInit, timeoutMs: number, fetchImpl: FetchLike): Promise<Response> {
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

/**
 * The live embedder. Every failure is retried under the gateway's policy or thrown; the decision
 * to degrade to lexical belongs to `scoreAgainst`, so a doctor probe still sees the real error.
 */
function providerEmbed(
  selection: EmbedderSelection,
  apiKey: string,
  cache: EmbeddingCache | undefined,
  options: CreateEmbedderOptions,
): EmbedFn {
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const policy = resolveRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${selection.baseUrl}/embeddings`;

  async function requestBatch(inputs: readonly string[]): Promise<number[][]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchWithDeadline(
          url,
          {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: selection.model, input: [...inputs] }),
          },
          timeoutMs,
          fetchImpl,
        );
        if (!response.ok) {
          throw new ProviderHttpError({
            provider: selection.label,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: await response.text().catch(() => ""),
          });
        }
        return parseEmbeddings(await response.json(), inputs.length);
      } catch (error) {
        const classified = classifyProviderError(error);
        if (!classified.retryable || attempt >= policy.attempts) throw error;
        await sleep(retryDelayMs({
          attempt,
          policy,
          ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
        }));
      }
    }
  }

  return async (texts) => {
    const prepared = texts.map((t) => t.slice(0, MAX_EMBED_INPUT_CHARS));
    const out = new Array<number[]>(prepared.length).fill([]);
    // Deduplicated by text: one recall corpus routinely repeats a step output across runs.
    const pending = new Map<string, number[]>();
    prepared.forEach((text, index) => {
      if (text.trim() === "") return;
      const hit = cache?.read(selection.model, text);
      if (hit !== undefined) {
        out[index] = hit;
        return;
      }
      const slots = pending.get(text);
      if (slots === undefined) pending.set(text, [index]);
      else slots.push(index);
    });

    const unique = [...pending.keys()];
    for (let start = 0; start < unique.length; start += selection.batchSize) {
      const batch = unique.slice(start, start + selection.batchSize);
      const vectors = await requestBatch(batch);
      batch.forEach((text, i) => {
        const vector = vectors[i] ?? [];
        cache?.write(selection.model, text, vector);
        for (const slot of pending.get(text) ?? []) out[slot] = vector;
      });
    }
    return out;
  };
}

/**
 * The embedder for one profile. `provider: "none"` is a first-class outcome, not an error: it
 * hands back the lexical vectors so a caller that ignores `provider` still works.
 */
export function createEmbedder(
  config: EmbedderConfigSource,
  secrets: SecretLookup,
  options: CreateEmbedderOptions = {},
): Embedder {
  const env = options.env ?? process.env;
  const selection = selectEmbedderProvider(config, secrets, env);
  if (selection.provider === "none") {
    return { embed: lexicalEmbedFn, provider: "none", model: "", dims: 0 };
  }
  const endpoint = endpointFor(selection.provider, config, env);
  const key = findKey(endpoint.apiKeyEnvs, secrets, env)?.value
    ?? (endpoint.local ? LOCAL_PLACEHOLDER_KEY : undefined);
  if (key === undefined) {
    return { embed: lexicalEmbedFn, provider: "none", model: "", dims: 0 };
  }
  const cache = options.useCache === false || options.profileDir === undefined
    ? undefined
    : new EmbeddingCache(options.profileDir, `${selection.provider}${SEPARATOR}${selection.baseUrl}`);
  // The floor rides on the function so a bare `EmbedFn` through the hook's seam stays calibrated.
  const embed: CalibratedEmbedFn = Object.assign(providerEmbed(selection, key, cache, options), {
    vectorFloor: selection.vectorFloor,
  });
  return { embed, provider: selection.provider, model: selection.model, dims: selection.dims };
}

/** The minimum of `ConfigManager` this needs; the real one satisfies it structurally. */
export interface EmbedderProfileSource {
  loadConfig(): EmbedderConfigSource;
  loadSecrets(): SecretLookup;
  getProfileDir(): string;
}

/**
 * One line for the runtime owner: `embed: embedderForProfile(configManager)`. `undefined` when
 * nothing is configured, on purpose — passing the lexical embedder through the seam would blend
 * lexical vectors with themselves and change an order nobody asked to change.
 */
export function embedderForProfile(source: EmbedderProfileSource): EmbedFn | undefined {
  let secrets: SecretLookup = {};
  try {
    secrets = source.loadSecrets();
  } catch {
    secrets = {};
  }
  const embedder = createEmbedder(source.loadConfig(), secrets, { profileDir: source.getProfileDir() });
  return embedder.provider === "none" ? undefined : embedder.embed;
}
