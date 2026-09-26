/**
 * [L0-1] The half of the config -> env model bridge that imports NO app code, so the CLI entry can run
 * it before anything else is evaluated (`apps/cli/src/env-defaults.ts`).
 *
 * Why it must run that early (local-path audit 2026-09-26, G1): `apps/web/lib/ai-client.ts` builds
 * `MODELS` from `OPENAI_MODEL_*` / `ANTHROPIC_MODEL_*` ONCE, when it is first evaluated, and
 * `apps/web/lib/orchestrator-runtime.ts` freezes `PLANNER_MODEL` / `SPECIALIST_MODEL` / `CRITIC_MODEL`
 * from it the same way. The CLI's static graph evaluates both at start (`commands -> improve ->
 * gepa/index.ts -> apps/web/lib/gepa.ts`), long before `createOrchestrator` runs `applyModelEnv`. So
 * under `provider: ollama` every seat and the consolidator asked the local runtime for `gpt-5.2` or
 * `gpt-4.1-mini`, and the ledger recorded those names.
 *
 * What lives here: the tier tables and the set-if-unset writer `model-env.ts` has always used (moved,
 * unchanged), the per-run pin (moved, unchanged), and the early entry: read the active profile's
 * `config.yaml` (only `provider`, `model` and `models`) and write the model NAME variables. It never
 * writes the alias identity, a key or a base URL: those are read per call, and `applyModelEnv` writes
 * them for the surfaces that route. `model-env.ts` re-exports everything public here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { EXIT, TrentError } from "../errors/index.js";
import { resolveProviderAlias } from "../model-gateway/providers.js";
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
export const ROUTER_PROVIDERS: ReadonlySet<string> = new Set(["openai", "anthropic", "google", "mistral", "openrouter"]);

/** The per-tier variables each provider's resolver reads, keyed by the app's `ModelTier`. */
export const TIER_VAR_BY_PROVIDER: Record<string, Readonly<Record<ModelTier, string>>> = {
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
export function tierVars(provider: string): readonly string[] {
  const tiers = TIER_VAR_BY_PROVIDER[provider];
  if (!tiers) return [];
  return [...MODEL_TIERS.map((tier) => tiers[tier]).filter((name): name is string => typeof name === "string" && name !== ""),
    ...(FOLLOWER_VARS[provider] ?? []).map((entry) => entry.name)];
}

/** The model configured for one tier: its own name, else the executor, else the single model. */
export function modelForTier(config: ModelEnvConfig, tier: ModelTier): string {
  const tiers = config.models;
  const named = tier === "haiku" ? tiers?.fast : tier === "opus" ? tiers?.planner : tiers?.executor;
  for (const candidate of [named, tiers?.executor, config.model]) {
    const value = candidate?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

export function setIfUnset(name: string, value: string, written: string[], kept: string[]): void {
  const current = process.env[name];
  if (current !== undefined && current.trim() !== "") {
    // [P2-1] A variable the pin wrote is reported as written, not as an operator's value kept.
    if (!written.includes(name)) kept.push(name);
    return;
  }
  process.env[name] = value;
  written.push(name);
}

/** Writes each tier variable this provider reads with that tier's model. Operator values win. */
export function applyTierEnv(provider: string, config: ModelEnvConfig, written: string[], kept: string[]): void {
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

// [L0-1] the early entry ────────────────────────────────────────────────────────────────────────

/**
 * Only the model NAMES the app freezes at load, from the config (or the pin, which is forced):
 * the routed provider's tier variables, operator values kept. An alias routes as `openai`, and a
 * blank model falls back to the alias's default, exactly as `applyProviderAliasEnv` would fill it.
 * Returns the names written.
 */
export function applyModelNameEnv(config: ModelEnvConfig | undefined): string[] {
  if (!config) return [];
  const provider = config.provider.trim().toLowerCase();
  if (config.pin !== undefined) return applyModelPinEnv(config.pin, provider, config.models?.fallback_on_pin === true);
  const alias = resolveProviderAlias(provider);
  const routed = alias?.provider ?? provider;
  if (!ROUTER_PROVIDERS.has(routed)) return [];
  const model = config.model.trim() === "" ? (alias?.defaultModel ?? "") : config.model;
  const written: string[] = [];
  applyTierEnv(routed, { ...config, model }, written, []);
  return written;
}

/** Where the CLI looks: its argv, its environment, and the home directory `~/.trent` hangs off. */
export interface ProfileModelSource {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

/** A profile name that is one path segment; anything else is left to the command to refuse. */
const PROFILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

/** The value of a global flag, as `commands/index.ts` reads it: `--flag v`, `--flag=v`, or the short form. */
function flagValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (names.includes(arg)) return argv[index + 1];
    const long = names.find((name) => name.startsWith("--") && arg.startsWith(`${name}=`));
    if (long !== undefined) return arg.slice(long.length + 1);
  }
  return undefined;
}

/**
 * The profile's `config.yaml`, resolved the way `ConfigManager` resolves it: `--profile` / `-p`, else
 * `TRENT_PROFILE`, else `default`; under `TRENT_HOME`, else `~/.trent`; a named profile under
 * `profiles/<name>`. Undefined for a profile name that is not one path segment.
 */
export function profileConfigPath(source: ProfileModelSource): string | undefined {
  const profile = flagValue(source.argv, ["--profile", "-p"]) || source.env.TRENT_PROFILE || "default";
  if (!PROFILE_NAME.test(profile)) return undefined;
  const base = source.env.TRENT_HOME || path.join(source.homeDir ?? os.homedir(), ".trent");
  return profile === "default" ? path.join(base, "config.yaml") : path.join(base, "profiles", profile, "config.yaml");
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= MAX_MODEL_PIN_LENGTH && MODEL_PIN_PATTERN.test(value.trim());
}

function tiersFrom(raw: unknown): ModelTierConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const block = raw as Record<string, unknown>;
  const picked: Record<string, string | boolean> = {};
  for (const key of ["fast", "executor", "planner", "judge"] as const) {
    if (isModelId(block[key])) picked[key] = (block[key] as string).trim();
  }
  if (typeof block.fallback_on_pin === "boolean") picked.fallback_on_pin = block.fallback_on_pin;
  return Object.keys(picked).length === 0 ? undefined : (picked as ModelTierConfig);
}

/**
 * `provider`, `model` and `models` from the active profile's `config.yaml`, checked field by field.
 * Undefined when there is no file, no usable provider, or the file does not parse: this is a
 * best-effort head start, and the command's own `ConfigManager.loadConfig` reads the same file
 * moments later and reports any fault in it with the typed configuration error (exit 3).
 */
export function readProfileModelConfig(source: ProfileModelSource): ModelEnvConfig | undefined {
  const file = profileConfigPath(source);
  if (file === undefined || !fs.existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined; // reported by the command's own load, with the file named
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const doc = raw as Record<string, unknown>;
  const provider = typeof doc.provider === "string" ? doc.provider.trim().toLowerCase() : "";
  if (!PROVIDER_NAME.test(provider)) return undefined;
  const models = tiersFrom(doc.models);
  return { provider, model: isModelId(doc.model) ? doc.model.trim() : "", ...(models === undefined ? {} : { models }) };
}

/** `trent [globals] run ... --model <id>`: the pin of a run process, or undefined. */
export function runPinFromArgv(argv: readonly string[]): string | undefined {
  let command: string | undefined;
  for (let index = 0; index < argv.length && command === undefined; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--profile" || arg === "-p") index++;
    else if (!arg.startsWith("-")) command = arg;
  }
  if (command !== "run") return undefined;
  const pin = flagValue(argv, ["--model"]);
  return isModelId(pin) ? pin.trim() : undefined;
}

/**
 * The entry's call: the active profile's model names into `process.env` before any app module is
 * evaluated. Returns the names written (never values). Never throws: a missing or broken config is
 * the command's to report.
 */
export function applyProfileModelEnv(source: ProfileModelSource): string[] {
  const config = readProfileModelConfig(source);
  if (config === undefined) return [];
  const pin = runPinFromArgv(source.argv);
  try {
    return applyModelNameEnv(pin === undefined ? config : { ...config, pin });
  } catch (error) {
    // Only the pin can throw (an openrouter pin without its `anthropic/` prefix); `trent run` parses
    // the same pin and refuses it with this error's own message, so nothing is lost by writing nothing.
    if (error instanceof TrentError) return [];
    throw error;
  }
}
