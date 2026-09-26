/**
 * Which ranker fleet recall is actually running (C3).
 *
 * "The embedder is configured" is a claim about a YAML file; "this key embedded a string a second
 * ago" is evidence. So this check follows the credentials check exactly: resolve the provider,
 * then make ONE cheap embedding call and classify the outcome. The cache is deliberately off for
 * the probe — a cached vector proves what the key could do the last time, not today — and the
 * retry policy is a single attempt, because the doctor reports a failure rather than working
 * around it.
 *
 * With nothing configured the line says lexical, and says it as a skip: lexical recall works, but
 * a skipped check is not a pass and the operator should see which of the two they are running.
 *
 * [L0-5] A local embedder (Ollama, LM Studio, llama.cpp) is checked the way its failure would show:
 * is the runtime reachable, is the model pulled (with the pull line when it is not), how many
 * dimensions it returns, the floor it is ranked against, and how many of the three fixed triples
 * that floor gets right (`fleet-memory/embedder-calibration.ts`). A cloud 404 names the model.
 */
import {
  DEFAULT_EMBED_TIMEOUT_MS,
  createEmbedder,
  selectEmbedderProvider,
  type EmbedderSelection,
} from "../../fleet-memory/embedder.js";
import { RECORDED_LOCAL_FLOORS, calibrationSanity, floorFromPairs, measureCalibration } from "../../fleet-memory/embedder-calibration.js";
import {
  LOCAL_EMBEDDER_ROUTES,
  fetchWithDeadline,
  isLocalEmbedderProvider,
  localFixHint,
  normaliseLocalModel,
  type LocalEmbedderProvider,
} from "../../fleet-memory/embedder-local.js";
import { ProviderHttpError } from "../../model-gateway/retry.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../probe.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Memory";
const NAME = "Recall Embedder";
/** [L0-5] A local model's cold load, behind another model on a busy runtime, is slow by design. */
const LOCAL_EMBED_PROBE_MS = 40_000;

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/** The secrets file is optional; a profile that has never been written is not a failure here. */
function secretsOf(ctx: DoctorContext): Record<string, string | undefined> {
  try {
    return ctx.configManager.loadSecrets() as unknown as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/** The model names a local runtime serves: Ollama's `/api/tags`, or the OpenAI dialect's `/models`. */
async function listLocalModels(provider: LocalEmbedderProvider, baseUrl: string, ctx: DoctorContext): Promise<string[]> {
  const fetchImpl = ctx.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const ollama = LOCAL_EMBEDDER_ROUTES[provider].dialect === "ollama";
  const response = await fetchWithDeadline(ollama ? `${baseUrl}/api/tags` : `${baseUrl}/models`, { method: "GET" }, ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, fetchImpl);
  if (!response.ok) throw new ProviderHttpError({ provider: LOCAL_EMBEDDER_ROUTES[provider].label, status: response.status, statusText: response.statusText });
  const payload = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }>; data?: Array<{ id?: unknown }> };
  const names = ollama ? (payload.models ?? []).flatMap((m) => [m.name, m.model]) : (payload.data ?? []).map((m) => m.id);
  return names.filter((n): n is string => typeof n === "string").map(normaliseLocalModel);
}

async function checkLocal(ctx: DoctorContext, config: Parameters<typeof createEmbedder>[0], selection: EmbedderSelection & { provider: LocalEmbedderProvider }): Promise<CheckResult> {
  const { label, model, baseUrl: endpoint, provider } = selection;
  const base = { provider, label, model, endpoint, batchSize: selection.batchSize };

  let served: string[];
  try {
    served = await listLocalModels(provider, endpoint, ctx);
  } catch (error) {
    return result({
      status: "warn",
      message: `${label} is not reachable at ${endpoint}, so recall ranks lexically (TF-IDF only): ${error instanceof Error ? error.message : String(error)}`,
      fixHint: localFixHint(provider, model, "unreachable"),
      details: { ...base, reachable: false, ranker: "lexical" },
    });
  }
  if (!served.includes(normaliseLocalModel(model))) {
    return result({
      status: "warn",
      message: `${label} is reachable at ${endpoint} but does not serve "${model}", so recall ranks lexically (TF-IDF only).`,
      fixHint: localFixHint(provider, model, "model_missing"),
      details: { ...base, reachable: true, modelPresent: false, ranker: "lexical" },
    });
  }

  const embedder = createEmbedder(config, secretsOf(ctx), {
    ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
    env: ctx.env ?? process.env,
    timeoutMs: ctx.probeTimeoutMs === undefined ? LOCAL_EMBED_PROBE_MS : Math.max(ctx.probeTimeoutMs, 1),
    useCache: false,
    retry: { attempts: 1 },
    warn: () => undefined, // this check reports the failure itself
  });
  let pairs: Awaited<ReturnType<typeof measureCalibration>>;
  let dims: number;
  try {
    // The shipped space: the query prefixed when the model has a prefix, documents as documents.
    pairs = await measureCalibration(embedder.embed, embedder.taskTypes);
    dims = (await embedder.embed(["."]))[0]?.length ?? 0;
  } catch (error) {
    return result({
      status: "warn",
      message: `${label} lists "${model}" but did not embed with it within the deadline, so recall ranks lexically: ${error instanceof Error ? error.message : String(error)}`,
      fixHint: localFixHint(provider, model, error instanceof ProviderHttpError && error.status < 500 ? "rejected" : "unreachable"),
      details: { ...base, reachable: true, modelPresent: true, ranker: "lexical" },
    });
  }

  const recorded = RECORDED_LOCAL_FLOORS[normaliseLocalModel(model)];
  const floor = recorded === undefined ? floorFromPairs(pairs) : embedder.taskTypes ? recorded.queryFloor : recorded.vectorFloor;
  const floorSource = recorded === undefined ? "calibrated" : "recorded";
  const sanity = floor === undefined ? 0 : calibrationSanity(pairs, floor);
  const details = { ...base, reachable: true, modelPresent: true, dims, floor: floor ?? null, floorSource, sanity, pairs, ranker: sanity > 0 ? "hybrid" : "lexical" };
  if (floor === undefined || sanity < 3) {
    return result({
      status: "warn",
      message: floor === undefined
        ? `${label} ${model} (${dims} dimensions) cannot tell a paraphrase from an unrelated sentence on the three fixed triples, so its vectors earn no credit and recall is lexical.`
        : `${label} ${model} (${dims} dimensions): the ${floorSource} floor ${floor.toFixed(2)} gets ${sanity}/3 fixed triples right, so hybrid recall is miscalibrated.`,
      fixHint: "Use an embedding model with a recorded floor (memory.embedder.model), or re-measure this one with the live calibration in fleet-memory/embedder.live.test.ts.",
      details,
    });
  }
  return result({
    status: "ok",
    message: `Fleet recall is hybrid: ${label} ${model} (${dims} dimensions) blended with lexical TF-IDF; floor ${floor.toFixed(2)} (${floorSource}), sanity ${sanity}/3.`,
    details,
  });
}

export const checkEmbedder: DoctorCheck = {
  id: "check_embedder",
  name: NAME,
  category: CATEGORY,
  timeoutMs: LOCAL_EMBED_PROBE_MS + DEFAULT_PROBE_TIMEOUT_MS, // [L0-5] a local cold load; a hosted probe needs far less
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const config = ctx.configManager.loadConfig();
    const secrets = secretsOf(ctx);
    const selection = selectEmbedderProvider(config, secrets, ctx.env ?? process.env);

    if (selection.provider === "none") {
      const disabled = selection.reason === "disabled";
      return result({
        status: "skip",
        message: disabled
          ? "memory.embedder.provider is none: fleet recall is lexical only (TF-IDF over the candidate corpus), and no embedding endpoint was contacted."
          : "No embedding key is configured, so fleet recall is lexical only (TF-IDF over the candidate corpus). Hybrid ranking is off.",
        fixHint: disabled
          ? "Set memory.embedder.provider to auto (or ollama for a local model) in config.yaml to rank with embeddings as well."
          : "Add a key with `trent config set GEMINI_API_KEY <your-api-key>` (or OPENAI_API_KEY), or set memory.embedder.provider to ollama for a local model.",
        details: { provider: "none", reason: selection.reason, ranker: "lexical" },
      });
    }
    if (isLocalEmbedderProvider(selection.provider)) {
      return checkLocal(ctx, config, { ...selection, provider: selection.provider });
    }

    const timeoutMs = ctx.probeTimeoutMs ?? Math.min(DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_EMBED_TIMEOUT_MS);
    const embedder = createEmbedder(config, secrets, {
      ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }),
      timeoutMs,
      useCache: false,
      retry: { attempts: 1 },
    });

    const base = {
      provider: selection.provider,
      label: selection.label,
      model: selection.model,
      envVar: selection.apiKeyEnv ?? null,
      endpoint: selection.baseUrl,
      batchSize: selection.batchSize,
    };

    let vector: number[] | undefined;
    let failure: unknown;
    try {
      // One token of input: the cheapest request the embeddings API accepts.
      vector = (await embedder.embed(["."]))[0];
    } catch (error) {
      failure = error;
    }

    if (failure !== undefined) {
      const message = failure instanceof Error ? failure.message : String(failure);
      // The status decides, not the prose: 401/403 is the operator's key, anything else is not.
      const status = failure instanceof ProviderHttpError ? failure.status : undefined;
      const rejected = status === 401 || status === 403;
      if (status === 404) {
        // [L0-5] The endpoint answered; the model is what it does not have.
        return result({
          status: "warn",
          message: `${selection.label} has no embedding model "${selection.model}" (HTTP 404), so recall ranks lexically: ${message}`,
          fixHint: `Set memory.embedder.model to an embedding model ${selection.label} serves.`,
          details: { ...base, probe: "model_missing" },
        });
      }
      return result({
        status: rejected ? "fail" : "warn",
        message: rejected
          ? `${selection.label} rejected ${selection.apiKeyEnv ?? "the configured key"} for embeddings: ${message}`
          : `${selection.label} could not be reached for embeddings within ${timeoutMs}ms, so hybrid recall is unproven on this machine: ${message}`,
        fixHint: rejected
          ? `Issue a key with embedding access in the ${selection.label} console, then \`trent config set ${selection.apiKeyEnv ?? "GEMINI_API_KEY"} <your-api-key>\`.`
          : "Re-run `trent doctor` once the provider is reachable; recall falls back to lexical ranking meanwhile.",
        details: { ...base, probe: rejected ? "unauthorized" : "unreachable" },
      });
    }

    if (vector === undefined || vector.length === 0) {
      return result({
        status: "fail",
        message: `${selection.label} answered the embeddings request with no vector, so hybrid recall cannot rank anything.`,
        fixHint: `Check that model "${selection.model}" exists on ${selection.label}; set memory.embedder.model to one that does.`,
        details: { ...base, probe: "empty" },
      });
    }

    return result({
      status: "ok",
      message: `Fleet recall is hybrid: ${selection.label} ${selection.model} (${vector.length} dimensions) blended with lexical TF-IDF.`,
      details: { ...base, dims: vector.length, probe: "ok", ranker: "hybrid" },
    });
  },
};
