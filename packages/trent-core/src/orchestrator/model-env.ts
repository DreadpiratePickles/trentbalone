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

import { EXIT, TrentError } from "../errors/index.js";
import { seatCapability } from "../fleet/seat-capabilities.js";
import { applyModelCallEnv } from "../model-gateway/call-policy.js";
import { applyModelOverridesEnv } from "../model-gateway/pricing.js";
import { aliasEnvKeys, applyProviderAliasEnv, resolveProviderAlias } from "../model-gateway/providers.js";
import type { OrchestratorModelConfig } from "./types.js";

/**
 * B2 — the tier models. `apps/web/lib/model-gateway.ts` routes a seat to a `ModelTier`
 * (haiku/sonnet/opus) and `resolveModelName` (`apps/web/lib/ai-client.ts:55`) turns that tier into
 * a model through the per-provider FAST/DEFAULT/STRONG variables. Writing the ONE configured model
 * into all three (the old `TIER_VARS` loop) collapsed every seat onto one model whatever its
 * manifest said. These are the names the rest of the wrapper already uses for the same two models
 * (`model-gateway/types.ts` `models: { executor, planner }`).
 */
export interface ModelTierConfig {
  /** The cheap tier (haiku). Defaults to `executor`. */
  readonly fast?: string;
  /** The working tier (sonnet), and the fallback for every other tier. */
  readonly executor?: string;
  /** The strong tier (opus), which the app also uses for the critic. Defaults to `executor`. */
  readonly planner?: string;
  /** B2.1: the critic's own model, where a provider has a critic variable. Defaults to its tier. */
  readonly judge?: string;
  /** [P1-C] A pinned model may fall back across providers. Bridged to the gateway, not a tier. */
  readonly fallback_on_pin?: boolean;
  /** [P1-C] `reasoning_effort` on the call. Bridged to the gateway, not a tier. */
  readonly reasoning_effort?: string;
}

/** The model block `applyModelEnv` reads: the configured provider/model plus the optional tiers. */
export type ModelEnvConfig = OrchestratorModelConfig & {
  readonly models?: ModelTierConfig;
  // [P2-1] the per-run model pin
  /**
   * This process's pin (`trent run --model <id>`, a pinned cron job's child run): written over every
   * model variable, operator values included, so every call of the run names it (`applyModelPinEnv`).
   */
  readonly pin?: string;
};

/** The app's three model tiers, in the order the per-provider variable lists use. */
export const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Providers the orchestrator's router knows. `parsePreferredProvider` ignores anything else. */
const ROUTER_PROVIDERS = new Set(["openai", "anthropic", "google", "mistral", "openrouter"]);

/** The per-tier variables each provider's resolver reads, keyed by the app's `ModelTier`. */
const TIER_VAR_BY_PROVIDER: Record<string, Readonly<Record<ModelTier, string>>> = {
  google: { haiku: "GOOGLE_MODEL_FAST", sonnet: "GOOGLE_MODEL_DEFAULT", opus: "GOOGLE_MODEL_STRONG" },
  openai: { haiku: "OPENAI_MODEL_FAST", sonnet: "OPENAI_MODEL_DEFAULT", opus: "OPENAI_MODEL_STRONG" },
  anthropic: { haiku: "ANTHROPIC_MODEL_FAST", sonnet: "ANTHROPIC_MODEL_DEFAULT", opus: "ANTHROPIC_MODEL_STRONG" },
  mistral: { haiku: "MISTRAL_MODEL_FAST", sonnet: "MISTRAL_MODEL_DEFAULT", opus: "MISTRAL_MODEL_STRONG" },
  // openrouter derives its names from the anthropic tier table with an `anthropic/` prefix, so no
  // tier of its own can be expressed there; only the provider preference is mapped.
  openrouter: {} as Readonly<Record<ModelTier, string>>,
};

/** Variables that are not a tier of their own but follow one. `OPENAI_MODEL_CRITIC` follows opus. */
const FOLLOWER_VARS: Record<string, ReadonlyArray<{ readonly name: string; readonly tier: ModelTier }>> = {
  openai: [{ name: "OPENAI_MODEL_CRITIC", tier: "opus" }],
};

/** The variables of a provider, in FAST/DEFAULT/STRONG (then follower) order. */
function tierVars(provider: string): readonly string[] {
  const tiers = TIER_VAR_BY_PROVIDER[provider];
  if (!tiers) return [];
  return [...MODEL_TIERS.map((tier) => tiers[tier]).filter((name): name is string => typeof name === "string" && name !== ""),
    ...(FOLLOWER_VARS[provider] ?? []).map((entry) => entry.name)];
}

/** The model configured for one tier: its own name, else the executor, else the single model. */
function modelForTier(config: ModelEnvConfig, tier: ModelTier): string {
  const tiers = config.models;
  const named = tier === "haiku" ? tiers?.fast : tier === "opus" ? tiers?.planner : tiers?.executor;
  for (const candidate of [named, tiers?.executor, config.model]) {
    const value = candidate?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/** Writes each tier variable this provider reads with that tier's model. Operator values win. */
function applyTierEnv(provider: string, config: ModelEnvConfig, written: string[], kept: string[]): void {
  const tiers = TIER_VAR_BY_PROVIDER[provider];
  if (!tiers) return;
  for (const tier of MODEL_TIERS) {
    const name = tiers[tier];
    const value = modelForTier(config, tier);
    if (typeof name === "string" && name !== "" && value !== "") setIfUnset(name, value, written, kept);
  }
  for (const follower of FOLLOWER_VARS[provider] ?? []) {
    // B2.1: `models.judge` names the critic outright; unset, the critic follows its tier as before.
    const judge = config.models?.judge?.trim();
    const value = judge === undefined || judge === "" ? modelForTier(config, follower.tier) : judge;
    if (value !== "") setIfUnset(follower.name, value, written, kept);
  }
}

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

function setIfUnset(name: string, value: string, written: string[], kept: string[]): void {
  const current = process.env[name];
  if (current !== undefined && current.trim() !== "") {
    // [P2-1] A variable the pin wrote is reported as written, not as an operator's value kept.
    if (!written.includes(name)) kept.push(name);
    return;
  }
  process.env[name] = value;
  written.push(name);
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
    return {
      written: [...tierWritten, ...report.written, ...pricing],
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
  if (resolveProviderAlias(key)) return aliasEnvKeys();
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

// [P2-1] the per-run model pin ────────────────────────────────────────────────────────────────

/** Longest model id a pin accepts; real ids are well under it, and argv and env stay bounded. */
const MAX_MODEL_PIN_LENGTH = 200;
/** A model id: letters, digits and `. _ : / @ + -`, not starting with `-` (it would parse as a flag). */
const MODEL_PIN_PATTERN = /^[A-Za-z0-9][\w.:/@+-]*$/;
/** What `anthropic/<m>` loses on openrouter: the app builds openrouter seat names as `anthropic/${anthropic tier}`. */
const OPENROUTER_ANTHROPIC_PREFIX = "anthropic/";
/** The gateway's workbench route reads these for the planner, the critic and the consolidator. */
const WORKBENCH_MODEL_VARS = ["WORKBENCH_PLANNER_MODEL", "WORKBENCH_EXECUTOR_MODEL"] as const;

function pinError(message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "model.pin", message, target });
}

/**
 * [P2-1] A pin as the flag or the job record carries it, trimmed and checked: a model id, not a
 * blank, not a sentence, not something a child process would read as a flag.
 */
export function parseModelPin(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") throw pinError("--model needs a model id of the profile's provider, e.g. --model gemini-3.6-flash", String(raw ?? ""));
  if (value.length > MAX_MODEL_PIN_LENGTH || !MODEL_PIN_PATTERN.test(value)) {
    throw pinError(`--model must be one model id (letters, digits and . _ : / @ + -, at most ${MAX_MODEL_PIN_LENGTH} characters)`, value.slice(0, MAX_MODEL_PIN_LENGTH));
  }
  return value;
}

/**
 * [P2-1] Writes a per-run pin over every model variable a run's calls read, the operator's values
 * included: the provider's tier variables (every seat, whatever its tier, and the critic follower),
 * the gateway's workbench models (the planner, the critic and the consolidator) and the preferred
 * provider. Unless `models.fallback_on_pin` is true the provider chain is narrowed to the pin's
 * provider, so neither the app's seat loop nor the gateway answers a pinned call from another
 * provider's model (P1-C's rule, for every call of the run). Call it in a process that runs ONLY the
 * pinned run, before the libs load: `trent run --model`, and a pinned cron job's child of it.
 * Returns the names written; values are never logged.
 */
export function applyModelPinEnv(pin: string, provider: string, fallbackOnPin = false): string[] {
  const model = parseModelPin(pin);
  const key = provider.trim().toLowerCase();
  const routed = resolveProviderAlias(key)?.provider ?? key;
  if (!ROUTER_PROVIDERS.has(routed)) return []; // `assertRoutableModel` refuses the provider itself
  let tierModel = model;
  let tierProvider = routed;
  if (routed === "openrouter") {
    if (!model.startsWith(OPENROUTER_ANTHROPIC_PREFIX) || model.length === OPENROUTER_ANTHROPIC_PREFIX.length) {
      throw pinError(`openrouter builds its seat models as anthropic/<model>, so a pin there must be one (got ${model}); a seat could not run on it`, model);
    }
    tierModel = model.slice(OPENROUTER_ANTHROPIC_PREFIX.length);
    tierProvider = "anthropic";
  }
  const written: string[] = [];
  const force = (name: string, value: string): void => {
    process.env[name] = value;
    written.push(name);
  };
  for (const name of tierVars(tierProvider)) force(name, tierModel);
  for (const name of WORKBENCH_MODEL_VARS) force(name, model);
  force("MODEL_PREFERRED_PROVIDER", routed);
  if (!fallbackOnPin) force("MODEL_ALLOWED_PROVIDERS", routed);
  return written;
}
