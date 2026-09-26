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
 *
 * [P2-13] A call that names a role per text (`EmbedCallOptions.roles`) is embedded with Gemini's
 * asymmetric task types through the native endpoint (`embedder-google.ts`), cached per task type
 * (`embedder-cache.ts`), and ranked against the route's own task-typed floor (`queryFloor`). A call
 * that names none is byte-identical to the one before, on every route.
 */

import {
  DEFAULT_RETRY_POLICY,
  ProviderHttpError,
  classifyProviderError,
  resolveRetryPolicy,
  retryDelayMs,
  type RetryPolicy,
} from "../model-gateway/retry.js";
import { LOCAL_PLACEHOLDER_KEY, aliasBaseUrl, resolveProviderAlias } from "../model-gateway/providers.js";
import { lexicalEmbedFn, type CalibratedEmbedFn, type EmbedCallOptions, type EmbedFn } from "./lexical.js";
import { CACHE_SEPARATOR, EmbeddingCache } from "./embedder-cache.js";
import { GEMINI_TASK_TYPES, batchEmbedBody, batchEmbedUrl, nativeGeminiBase, parseBatchEmbedResponse } from "./embedder-google.js";

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
  /**
   * [P2-13] The same line for a RETRIEVAL_QUERY against RETRIEVAL_DOCUMENTs, on a route that has
   * asymmetric task types. Absent: the route has none, and roles are ignored.
   */
  readonly queryFloor?: number;
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
    // [P2-13] RETRIEVAL_QUERY against RETRIEVAL_DOCUMENT, measured by `embedder.live.test.ts` on the
    // same three sentences: unrelated 0.571, paraphrase 0.769. The symmetric floor's own rule
    // (unrelated + 0.3 x the gap: 0.529 + 0.3 x 0.225 = 0.60) gives 0.63 here.
    queryFloor: 0.63,
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
  /** [P2-13] True when a call's roles are honoured as asymmetric task types. */
  readonly taskTypes: boolean;
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
  /**
   * [P2-13] `true` honours a call's roles as asymmetric task types on a route that has them. Off by
   * default until the docs corpus measures them: the re-embed stopped at 317 of 665 texts on the free
   * tier's 1,000-requests-a-day embedding quota (HTTP 429), so the shipped space is still the symmetric
   * one the P2-6 numbers were measured in (01_discovery/output/retrieval-measurement-2026-09-25.md).
   */
  readonly taskTypes?: boolean;
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
 * `nativeBase` is set only when task types apply ([P2-13]); a text with a role then goes to the
 * native batch endpoint with its task type, and every other text to the compatible one as before.
 */
function providerEmbed(
  selection: EmbedderSelection,
  apiKey: string,
  cache: EmbeddingCache | undefined,
  options: CreateEmbedderOptions,
  nativeBase: string | undefined,
): EmbedFn {
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const policy = resolveRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${selection.baseUrl}/embeddings`;
  const nativeUrl = nativeBase === undefined ? undefined : batchEmbedUrl(nativeBase, selection.model);

  async function send(target: string, headers: Record<string, string>, body: unknown, parse: (payload: unknown) => number[][]): Promise<number[][]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetchWithDeadline(
          target,
          { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
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
        return parse(await response.json());
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

  /** Symmetric texts go to the compatible surface; task-typed ones to the native batch, each with its own type. */
  const requestBatch = (inputs: readonly string[], taskTypes: readonly (string | undefined)[]): Promise<number[][]> => {
    const typed = taskTypes.every((t): t is string => t !== undefined);
    return !typed || nativeUrl === undefined
      ? send(url, { authorization: `Bearer ${apiKey}` }, { model: selection.model, input: [...inputs] }, (p) => parseEmbeddings(p, inputs.length))
      : send(nativeUrl, { "x-goog-api-key": apiKey }, batchEmbedBody(selection.model, inputs, taskTypes as readonly string[]), (p) => parseBatchEmbedResponse(p, inputs.length));
  };

  return async (texts, call?: EmbedCallOptions) => {
    const prepared = texts.map((t) => t.slice(0, MAX_EMBED_INPUT_CHARS));
    const out = new Array<number[]>(prepared.length).fill([]);
    const taskTypeOf = (index: number): string | undefined => {
      const role = nativeUrl === undefined ? undefined : call?.roles?.[index];
      return role === undefined ? undefined : GEMINI_TASK_TYPES[role];
    };
    // Deduplicated by (task type, text): one recall corpus routinely repeats a step output across runs.
    const pending = new Map<string, { text: string; taskType: string | undefined; slots: number[] }>();
    prepared.forEach((text, index) => {
      if (text.trim() === "") return;
      const taskType = taskTypeOf(index);
      const hit = cache?.read(selection.model, text, taskType);
      if (hit !== undefined) {
        out[index] = hit;
        return;
      }
      const key = taskType === undefined ? text : `${taskType}${CACHE_SEPARATOR}${text}`;
      const entry = pending.get(key);
      if (entry === undefined) pending.set(key, { text, taskType, slots: [index] });
      else entry.slots.push(index);
    });

    // A request never mixes dialects; a native one carries a task type per text.
    const entries = [...pending.values()];
    for (const group of [entries.filter((e) => e.taskType === undefined), entries.filter((e) => e.taskType !== undefined)]) {
      for (let start = 0; start < group.length; start += selection.batchSize) {
        const batch = group.slice(start, start + selection.batchSize);
        const vectors = await requestBatch(batch.map((e) => e.text), batch.map((e) => e.taskType));
        batch.forEach((entry, i) => {
          const vector = vectors[i] ?? [];
          cache?.write(selection.model, entry.text, vector, entry.taskType);
          for (const slot of entry.slots) out[slot] = vector;
        });
      }
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
    return { embed: lexicalEmbedFn, provider: "none", model: "", dims: 0, taskTypes: false };
  }
  const endpoint = endpointFor(selection.provider, config, env);
  const key = findKey(endpoint.apiKeyEnvs, secrets, env)?.value
    ?? (endpoint.local ? LOCAL_PLACEHOLDER_KEY : undefined);
  if (key === undefined) {
    return { embed: lexicalEmbedFn, provider: "none", model: "", dims: 0, taskTypes: false };
  }
  const cache = options.useCache === false || options.profileDir === undefined
    ? undefined
    : new EmbeddingCache(options.profileDir, `${selection.provider}${CACHE_SEPARATOR}${selection.baseUrl}`);
  // [P2-13] Task types need the caller to ask for them, the route to have them, and a native
  // endpoint behind the base URL.
  const queryFloor = EMBEDDER_ROUTES[selection.provider].queryFloor;
  const nativeBase = options.taskTypes !== true || queryFloor === undefined ? undefined : nativeGeminiBase(selection.baseUrl);
  // The floors ride on the function so a bare `EmbedFn` through the hook's seam stays calibrated.
  const embed: CalibratedEmbedFn = Object.assign(providerEmbed(selection, key, cache, options, nativeBase), {
    vectorFloor: selection.vectorFloor,
    ...(nativeBase === undefined ? {} : { queryFloor }),
  });
  return { embed, provider: selection.provider, model: selection.model, dims: selection.dims, taskTypes: nativeBase !== undefined };
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
