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
 *
 * [L0-1] "Before the lazy import" was not early enough: the CLI's static graph evaluates
 * `ai-client.ts` at start (local-path audit 2026-09-26, G1). The model NAMES are therefore written
 * first of all by the CLI entry (`apps/cli/src/env-defaults.ts` -> `./model-env-early.ts`), and this
 * function then finds them set and keeps them; the alias identity, the key and the base URL, which the
 * app reads per call, are still written here.
 */

import { EXIT, TrentError } from "../errors/index.js";
import { seatCapability } from "../fleet/seat-capabilities.js";
import { applyModelCallEnv } from "../model-gateway/call-policy.js";
import { applyModelOverridesEnv } from "../model-gateway/pricing.js";
import { aliasEnvKeys, applyProviderAliasEnv, resolveProviderAlias } from "../model-gateway/providers.js";
// [L0-1] The app-free half moved to `./model-env-early.ts` so the CLI entry can apply the model names
// before any app module loads (G1); this module keeps what needs the seat manifest and re-exports the rest.
import {
  ROUTER_PROVIDERS,
  TIER_VAR_BY_PROVIDER,
  applyModelPinEnv,
  applyTierEnv,
  modelForTier,
  setIfUnset,
  tierVars,
  type ModelEnvConfig,
  type ModelTier,
} from "./model-env-early.js";

export {
  MODEL_TIERS,
  applyModelNameEnv,
  applyModelPinEnv,
  applyProfileModelEnv,
  parseModelPin,
  readProfileModelConfig,
  type ModelEnvConfig,
  type ModelTier,
  type ModelTierConfig,
} from "./model-env-early.js";

/**
 * The variable the app's resolver reads for THIS seat, from the seat's manifest tier
 * (`SEAT_MANIFESTS[role].modelTier`). `undefined` for a provider with no tier table of its own.
 */
export function seatTierVar(seat: string, provider: string): string | undefined {
  const tiers = TIER_VAR_BY_PROVIDER[provider.trim().toLowerCase()];
  const name = tiers?.[seatCapability(seat).modelTier as ModelTier];
  return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * The model this seat resolves to: what its tier variable holds (an operator's own value included),
 * falling back to the configured executor model and then to the single configured model. Values are
 * read, never logged.
 */
export function resolveSeatModel(seat: string, config: ModelEnvConfig | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (!config) return "";
  const provider = resolveProviderAlias(config.provider.trim().toLowerCase())?.provider ?? config.provider.trim().toLowerCase();
  const name = seatTierVar(seat, provider);
  const current = name === undefined ? undefined : env[name];
  if (current !== undefined && current.trim() !== "") return current.trim();
  return modelForTier(config, seatCapability(seat).modelTier as ModelTier);
}

export interface ModelEnvReport {
  /** Variables this call wrote. Names only — never values. */
  readonly written: readonly string[];
  /** Variables left alone because the operator had already set them. */
  readonly kept: readonly string[];
  /** True when the provider is outside the router's vocabulary and nothing could be mapped. */
  readonly unsupportedProvider: boolean;
  /**
   * Set when the provider IS known but this machine cannot route it — a hosted alias with no key.
   * Names the variable to set, never a value. The caller must fail with a typed configuration
   * error; before this existed the run silently drifted to whichever provider had a key.
   */
  readonly unroutableProvider?: string;
}

/**
 * Writes the configured provider and model into `process.env`. Idempotent. Call BEFORE the first
 * `apps/web` import.
 */
export function applyModelEnv(config: ModelEnvConfig | undefined): ModelEnvReport {
  const written: string[] = [];
  const kept: string[] = [];
  if (!config) return { written, kept, unsupportedProvider: false };

  const provider = config.provider.trim().toLowerCase();
  // [P2-1] A pin goes first and beats everything below, which only fills what is unset; the alias
  // route is handed the pin as its one model.
  const pinned = config.pin === undefined ? [] : applyModelPinEnv(config.pin, provider, config.models?.fallback_on_pin === true);
  written.push(...pinned);
  const model = (config.pin ?? config.model).trim();
  // Prices are not routing, so they are written whatever the provider turns out to be; so are the
  // [P1-C] call policies (fallback_on_pin, reasoning_effort), which the gateway reads per call.
  const pricing = [...applyModelOverridesEnv(config.overrides), ...applyModelCallEnv(config.models)];

  // `ollama`, `lmstudio`, `deepseek` and `groq` are OpenAI-compatible endpoints, not new provider
  // identities: the alias boundary resolves them into `openai` plus a base URL, which is what the
  // app's client already speaks (`apps/web/lib/ai-client.ts:116` honours OPENAI_BASE_URL).
  const alias = resolveProviderAlias(provider);
  if (alias) {
    // The alias writes one model into every OpenAI tier variable. Configured tiers are written
    // FIRST so the alias keeps them (it only fills what is unset); the base URL, the key and the
    // provider identity it resolves are untouched (A0.3).
    const tierWritten: string[] = [...pinned]; // [P2-1] the pin's names, so they are not reported kept
    const tierKept: string[] = [];
    if (config.models !== undefined) applyTierEnv(alias.provider, config, tierWritten, tierKept);
    const report = applyProviderAliasEnv(alias.alias, model);
    // [L0-1] G4: a local runtime's chain is its own endpoint. The app's seat loop otherwise asks the
    // seat port for every provider's tier model (claude-..., gemini-...), and the gateway falls back to
    // any keyed hosted provider. Forced like the pin's narrowing: no request leaves the machine.
    const localChain: string[] = [];
    if (alias.local && report.unroutable === undefined) {
      process.env.MODEL_ALLOWED_PROVIDERS = alias.provider;
      localChain.push("MODEL_ALLOWED_PROVIDERS");
    }
    return {
      written: [...tierWritten, ...report.written, ...localChain, ...pricing],
      kept: [...tierKept, ...report.kept.filter((name) => !pinned.includes(name))], // [P2-1]
      unsupportedProvider: false,
      ...(report.unroutable === undefined ? {} : { unroutableProvider: report.unroutable }),
    };
  }

  if (!ROUTER_PROVIDERS.has(provider)) return { written: [...written, ...pricing], kept, unsupportedProvider: true };

  setIfUnset("MODEL_PREFERRED_PROVIDER", provider, written, kept);
  applyTierEnv(provider, config, written, kept);
  return { written: [...written, ...pricing], kept, unsupportedProvider: false };
}

/** The variables `applyModelEnv` may write for a provider, for `trent doctor`. Values never read. */
export function modelEnvKeys(provider: string): readonly string[] {
  const key = provider.trim().toLowerCase();
  const alias = resolveProviderAlias(key);
  if (alias) return alias.local ? [...aliasEnvKeys(), "MODEL_ALLOWED_PROVIDERS"] : aliasEnvKeys(); // [L0-1] G4
  return ["MODEL_PREFERRED_PROVIDER", ...tierVars(key)];
}

/**
 * The report is READ, not ignored (harness audit D-7). Before this, `unsupportedProvider` came back
 * true for `ollama`, `deepseek` and `groq` and no caller looked at it, so a user who picked one got
 * a config Trent accepted, a doctor that passed and a run that quietly routed to whichever provider
 * happened to have a key — or degraded to the deterministic planner. A provider nothing can route
 * is a configuration failure (exit code 3) at construction. The message names a variable, never a
 * value.
 */
export function assertRoutableModel(report: ModelEnvReport, provider: string | undefined): void {
  if (!report.unsupportedProvider && report.unroutableProvider === undefined) return;
  const name = provider ?? "";
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "model.route",
    message:
      report.unroutableProvider
      ?? `provider "${name}" has no model gateway path; use one of anthropic, openai, google, mistral, openrouter, ollama, lmstudio, deepseek, groq`,
    target: name,
    context: { provider: name, envKeys: modelEnvKeys(name) },
  });
}
