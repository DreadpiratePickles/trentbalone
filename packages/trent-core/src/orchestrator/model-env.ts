/**
 * Config -> env for the orchestrator's model resolver.
 *
 * `resolveModelName(tier, provider)` (`apps/web/lib/ai-client.ts`) picks a model per tier from
 * `<PROVIDER>_MODEL_FAST/DEFAULT/STRONG`, and `buildModelPolicySnapshot()` picks the provider from
 * `MODEL_PREFERRED_PROVIDER`. Nothing in `apps/web` reads the CLI's config file, so a configured
 * `provider: google, model: gemini-3.5-flash-lite` never reached a seat: the resolver fell back to
 * retired defaults and every call 404'd (live proof, F2). This is the bridge.
 *
 * Ordering matters: the OpenAI and Anthropic names are FROZEN into `MODELS` when `ai-client.ts` is
 * first evaluated, so this must run before the wrapper's lazy `import("@/lib/...")`. Google and
 * Mistral are read per call, but the same rule is applied to all of them so the contract is one
 * sentence: "env is written, then the libs load."
 *
 * An operator's explicit env value wins over the config file (conventional precedence); the
 * mapping only fills variables that are unset or empty. Values are never logged.
 */

import type { OrchestratorModelConfig } from "./types.js";

/** Providers the orchestrator's router knows. `parsePreferredProvider` ignores anything else. */
const ROUTER_PROVIDERS = new Set(["openai", "anthropic", "google", "mistral", "openrouter"]);

/** The per-tier variables each provider's resolver reads, in FAST/DEFAULT/STRONG order. */
const TIER_VARS: Record<string, readonly string[]> = {
  google: ["GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG"],
  openai: ["OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"],
  anthropic: ["ANTHROPIC_MODEL_FAST", "ANTHROPIC_MODEL_DEFAULT", "ANTHROPIC_MODEL_STRONG"],
  mistral: ["MISTRAL_MODEL_FAST", "MISTRAL_MODEL_DEFAULT", "MISTRAL_MODEL_STRONG"],
  // openrouter derives its names from the anthropic tier table with an `anthropic/` prefix, so a
  // single configured model cannot be expressed there; only the provider preference is mapped.
  openrouter: [],
};

export interface ModelEnvReport {
  /** Variables this call wrote. Names only — never values. */
  readonly written: readonly string[];
  /** Variables left alone because the operator had already set them. */
  readonly kept: readonly string[];
  /** True when the provider is outside the router's vocabulary and nothing could be mapped. */
  readonly unsupportedProvider: boolean;
}

function setIfUnset(name: string, value: string, written: string[], kept: string[]): void {
  const current = process.env[name];
  if (current !== undefined && current.trim() !== "") {
    kept.push(name);
    return;
  }
  process.env[name] = value;
  written.push(name);
}

/**
 * Writes the configured provider and model into `process.env`. Idempotent. Call BEFORE the first
 * `apps/web` import.
 */
export function applyModelEnv(config: OrchestratorModelConfig | undefined): ModelEnvReport {
  const written: string[] = [];
  const kept: string[] = [];
  if (!config) return { written, kept, unsupportedProvider: false };

  const provider = config.provider.trim().toLowerCase();
  const model = config.model.trim();
  if (!ROUTER_PROVIDERS.has(provider)) return { written, kept, unsupportedProvider: true };

  setIfUnset("MODEL_PREFERRED_PROVIDER", provider, written, kept);
  if (model !== "") {
    for (const name of TIER_VARS[provider] ?? []) setIfUnset(name, model, written, kept);
  }
  return { written, kept, unsupportedProvider: false };
}

/** The variables `applyModelEnv` may write for a provider, for `trent doctor`. Values never read. */
export function modelEnvKeys(provider: string): readonly string[] {
  return ["MODEL_PREFERRED_PROVIDER", ...(TIER_VARS[provider.trim().toLowerCase()] ?? [])];
}
