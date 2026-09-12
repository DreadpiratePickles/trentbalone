import fs from "node:fs";
import dotenv from "dotenv";
import type { ConfigManager } from "../config/index.js";
import type { Provider } from "../config/schema.js";

/**
 * Which environment variable holds each provider's key. `ollama` runs locally and needs none, so it
 * declares an empty list and is never "detected" — a machine with no keys at all must fail the quick
 * path with an actionable message rather than silently configuring a provider the user did not pick.
 */
export const PROVIDER_ENV_VARS: Record<Provider, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  ollama: [],
};

/** The model written when the user does not choose one. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.6-terra",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  openrouter: "openrouter/auto",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  ollama: "llama3.2",
};

export type KeySource = "environment" | "profile env file";

export interface DetectedKey {
  provider: Provider;
  envVar: string;
  source: KeySource;
}

function isSet(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Parse the profile `.env` WITHOUT exporting anything into `process.env`. */
function readProfileEnv(configManager: ConfigManager): Record<string, string> {
  const secretsPath = configManager.getSecretsPath();
  if (!fs.existsSync(secretsPath)) return {};
  try {
    return dotenv.parse(fs.readFileSync(secretsPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Report which provider keys already exist, in declaration order, and where each came from.
 * Only NAMES are returned. A key's value never leaves this module.
 */
export function detectProviderKeys(
  configManager: ConfigManager,
  env: NodeJS.ProcessEnv,
  only?: Provider,
): DetectedKey[] {
  const fileEnv = readProfileEnv(configManager);
  const found: DetectedKey[] = [];

  for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS) as Array<
    [Provider, readonly string[]]
  >) {
    if (only && provider !== only) continue;
    for (const envVar of vars) {
      if (isSet(env[envVar])) {
        found.push({ provider, envVar, source: "environment" });
        break;
      }
      if (isSet(fileEnv[envVar])) {
        found.push({ provider, envVar, source: "profile env file" });
        break;
      }
    }
  }

  return found;
}

export function hasKeyFor(
  configManager: ConfigManager,
  env: NodeJS.ProcessEnv,
  provider: Provider,
): boolean {
  if (PROVIDER_ENV_VARS[provider].length === 0) return true; // local runtime, no credential
  return detectProviderKeys(configManager, env, provider).length > 0;
}

/**
 * The message shown when nothing was found. There is no hosted portal to sign into, so this names the
 * exact variables and the exact file instead of pretending to run an authorization flow.
 */
export function missingKeyGuidance(configManager: ConfigManager): string[] {
  const lines = [
    "No provider API key was found.",
    "Trent has no hosted sign-in. A key is read from one of two places:",
    `  1. your shell environment`,
    `  2. the profile env file at ${configManager.getSecretsPath()}`,
    "Set one of these variables, then run setup again:",
  ];
  for (const [provider, vars] of Object.entries(PROVIDER_ENV_VARS) as Array<
    [Provider, readonly string[]]
  >) {
    if (vars.length === 0) continue;
    lines.push(`  ${provider}: ${vars.join(" or ")}`);
  }
  lines.push(
    `For example: echo 'OPENAI_API_KEY=your-key' >> ${configManager.getSecretsPath()}`,
  );
  return lines;
}

/** The variable a user should set for a provider, when we have to name exactly one. */
export function primaryEnvVar(provider: Provider): string {
  return PROVIDER_ENV_VARS[provider][0] ?? `${provider.toUpperCase()}_API_KEY`;
}
