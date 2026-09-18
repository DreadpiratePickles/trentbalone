/**
 * Provider ALIASES — the four names the config accepts that the wrapped app's router does not
 * know (harness audit A.7, shortfall D-7).
 *
 * `config/schema.ts` has accepted `ollama`, `deepseek` and `groq` since the first release, the
 * setup wizard offered Ollama and the TUI model modal offered all three — and none of them reached
 * a model. `applyModelEnv` returned `unsupportedProvider: true`, nobody read it, and the run quietly
 * routed to whatever `buildModelPolicySnapshot()` defaulted to.
 *
 * The fix deliberately does NOT invent new provider identities. `ModelProvider` stays at the five
 * values `apps/web` understands, because every one of them is also a doctor probe, a price tier and
 * a routing decision inside a read-only app we may not edit. All four of these endpoints speak the
 * OpenAI `/chat/completions` dialect, and `createAIClient()` (`apps/web/lib/ai-client.ts:116`)
 * already honours `OPENAI_BASE_URL` — so an alias is resolved AT THE BOUNDARY into
 * `provider: "openai"` plus a base URL, and the real client streams it.
 *
 * Nothing here logs a key. `applyProviderAliasEnv` returns variable NAMES only.
 */

import type { ModelProvider } from "./types.js";

export const PROVIDER_ALIASES = ["ollama", "lmstudio", "deepseek", "groq"] as const;
export type ProviderAlias = (typeof PROVIDER_ALIASES)[number];

/** Env var naming the alias a run is routed through, for the surfaces built after the bridge. */
export const ALIAS_ENV = "TRENT_MODEL_ALIAS";

/**
 * The bearer sent to a local runtime that wants a header but has no accounts. It is not a
 * credential: Ollama and LM Studio accept any value. It exists so the OpenAI-compatible client,
 * which always sends `Authorization`, does not send the operator's real OpenAI key to localhost.
 */
export const LOCAL_PLACEHOLDER_KEY = "local";

export interface ProviderAliasRoute {
  readonly alias: ProviderAlias;
  readonly label: string;
  /** What the alias resolves to for the app's router. Today every alias is OpenAI-compatible. */
  readonly provider: ModelProvider;
  /** Env var an operator sets to move the endpoint (a remote Ollama, a proxy, a mirror). */
  readonly baseUrlEnv: string;
  readonly defaultBaseUrl: string;
  /** Where this alias's own key lives, when it has one. */
  readonly apiKeyEnv: string;
  readonly defaultModel: string;
  /** True for a runtime on the operator's own machine: no account, no key, no per-token cost. */
  readonly local: boolean;
}

export const PROVIDER_ALIAS_ROUTES: Readonly<Record<ProviderAlias, ProviderAliasRoute>> = {
  ollama: {
    alias: "ollama",
    label: "Ollama",
    provider: "openai",
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    defaultModel: "llama3.2",
    local: true,
  },
  lmstudio: {
    alias: "lmstudio",
    label: "LM Studio",
    provider: "openai",
    baseUrlEnv: "LMSTUDIO_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    defaultModel: "local-model",
    local: true,
  },
  deepseek: {
    alias: "deepseek",
    label: "DeepSeek",
    provider: "openai",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    local: false,
  },
  groq: {
    alias: "groq",
    label: "Groq",
    provider: "openai",
    baseUrlEnv: "GROQ_BASE_URL",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile",
    local: false,
  },
};

export function isProviderAlias(name: string): name is ProviderAlias {
  return (PROVIDER_ALIASES as readonly string[]).includes(name.trim().toLowerCase());
}

/** The route for a configured provider name, or nothing when the name is not an alias. */
export function resolveProviderAlias(name: string | undefined): ProviderAliasRoute | undefined {
  if (name === undefined) return undefined;
  const key = name.trim().toLowerCase();
  return isProviderAlias(key) ? PROVIDER_ALIAS_ROUTES[key] : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
}

/** The endpoint for an alias: the operator's env var if set, otherwise the shipped default. */
export function aliasBaseUrl(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): string {
  const route = PROVIDER_ALIAS_ROUTES[alias];
  return trimTrailingSlash(envValue(env, route.baseUrlEnv) ?? route.defaultBaseUrl);
}

/** The alias's own key, or nothing. Local runtimes usually have none. Values are never logged. */
export function aliasApiKey(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, PROVIDER_ALIAS_ROUTES[alias].apiKeyEnv);
}

/** The alias this process is routed through, written by `applyProviderAliasEnv`. */
export function activeProviderAlias(env: NodeJS.ProcessEnv = process.env): ProviderAlias | undefined {
  const raw = envValue(env, ALIAS_ENV);
  return raw !== undefined && isProviderAlias(raw) ? (raw.toLowerCase() as ProviderAlias) : undefined;
}

/** True when the tokens for this call were produced on the operator's own hardware. */
export function isLocalAlias(alias: ProviderAlias | undefined): boolean {
  return alias !== undefined && PROVIDER_ALIAS_ROUTES[alias].local;
}

export interface AliasEnvReport {
  /** Variables this call wrote. NAMES only — never values. */
  readonly written: readonly string[];
  /** Variables left alone because the operator had already set them. */
  readonly kept: readonly string[];
  /**
   * Set when the alias is known but cannot be routed — a hosted endpoint with no key. The caller
   * fails with a typed configuration error; it must never fall through to another provider.
   */
  readonly unroutable?: string;
}

/**
 * Resolve an alias into the env the app's OpenAI-compatible client reads, BEFORE any `apps/web`
 * import. Idempotent. An operator's explicit value wins, with one deliberate exception: the key.
 * A local endpoint gets the placeholder rather than whatever `OPENAI_API_KEY` happened to hold,
 * because the alternative is mailing a real OpenAI key to a process on localhost.
 */
export function applyProviderAliasEnv(
  alias: ProviderAlias,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): AliasEnvReport {
  const route = PROVIDER_ALIAS_ROUTES[alias];
  const written: string[] = [];
  const kept: string[] = [];

  const setIfUnset = (name: string, value: string): void => {
    if (envValue(env, name) !== undefined) {
      kept.push(name);
      return;
    }
    env[name] = value;
    written.push(name);
  };

  const key = aliasApiKey(alias, env);
  if (!route.local && key === undefined) {
    return {
      written,
      kept,
      unroutable: `${route.label} needs ${route.apiKeyEnv}; set it in the profile env file or the shell`,
    };
  }

  env[ALIAS_ENV] = alias;
  written.push(ALIAS_ENV);
  setIfUnset("MODEL_PREFERRED_PROVIDER", route.provider);
  setIfUnset("OPENAI_BASE_URL", aliasBaseUrl(alias, env));

  // The key is assigned, not merely defaulted: see the doc comment above.
  env.OPENAI_API_KEY = key ?? LOCAL_PLACEHOLDER_KEY;
  written.push("OPENAI_API_KEY");

  const chosenModel = model.trim() === "" ? route.defaultModel : model.trim();
  for (const name of ["OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"]) {
    setIfUnset(name, chosenModel);
  }
  return { written, kept };
}

/** The variables `applyProviderAliasEnv` may write, for `trent doctor`. Values are never read. */
export function aliasEnvKeys(): readonly string[] {
  return [
    ALIAS_ENV,
    "MODEL_PREFERRED_PROVIDER",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_MODEL_FAST",
    "OPENAI_MODEL_DEFAULT",
    "OPENAI_MODEL_STRONG",
    "OPENAI_MODEL_CRITIC",
  ];
}

/** Aliases that need no credential at all, for the doctor's credentials check. */
export const KEYLESS_ALIASES: ReadonlySet<string> = new Set(
  PROVIDER_ALIASES.filter((alias) => PROVIDER_ALIAS_ROUTES[alias].local),
);
