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
 */
import {
  DEFAULT_EMBED_TIMEOUT_MS,
  createEmbedder,
  selectEmbedderProvider,
} from "../../fleet-memory/embedder.js";
import { ProviderHttpError } from "../../model-gateway/retry.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../probe.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Memory";
const NAME = "Recall Embedder";

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

export const checkEmbedder: DoctorCheck = {
  id: "check_embedder",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const config = ctx.configManager.loadConfig();
    const secrets = secretsOf(ctx);
    const selection = selectEmbedderProvider(config, secrets);

    if (selection.provider === "none") {
      const disabled = selection.reason === "disabled";
      return result({
        status: "skip",
        message: disabled
          ? "memory.embedder.provider is none, so fleet recall ranks lexically (TF-IDF over the candidate corpus) and no embedding endpoint was contacted."
          : "No embedding key is configured, so fleet recall ranks lexically (TF-IDF over the candidate corpus). Hybrid ranking is off.",
        fixHint: disabled
          ? "Set memory.embedder.provider to auto in config.yaml to rank with embeddings as well."
          : "Add a key with `trent config set GEMINI_API_KEY <your-api-key>` (or OPENAI_API_KEY); memory.embedder.provider auto then picks it up.",
        details: { provider: "none", reason: selection.reason, ranker: "lexical" },
      });
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
