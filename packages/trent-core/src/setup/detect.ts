import fs from "node:fs";
import os from "node:os"; // [C9]
import dotenv from "dotenv";
import type { ConfigManager } from "../config/index.js";
import type { Provider } from "../config/schema.js";
import { RUNTIME_LABEL, createLocalDiscovery, type LocalDiscoveryPort } from "./local-detect.js"; // [C9]
import { chooseChat, chooseRuntime } from "./local-plan.js"; // [C9]

/**
 * Which environment variable holds each provider's key. `ollama` and `lmstudio` run locally and need
 * none, so they declare an empty list and are never "detected" — a machine with no keys at all must
 * fail the quick path with an actionable message rather than silently configuring a provider the
 * user did not pick.
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
  lmstudio: [],
};

/**
 * The model written when the user does not choose one. For `ollama` this is the smallest tier's
 * recommendation (`local-tiers.ts`); setup itself proposes the tier that fits the machine. It was
 * `llama3.2`, which Berkeley's leaderboard scores at 21.95% overall and 4% multi-turn.
 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: "gpt-5.6-terra",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  openrouter: "openrouter/auto",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  ollama: "qwen3.5:9b",
  lmstudio: "local-model",
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

// [C9] A keyless first run finds the model already on the machine.
/** The one command that sets Trent up on a model this machine already runs. It needs no key. */
export const LOCAL_SETUP_COMMAND = "trent setup --mode local";

/** A local runtime `trent setup --mode local` could use right now, and the chat model it would choose. */
export interface KeylessLocal {
  /** As a person says it: `Ollama`, `LM Studio`, `llama.cpp`. */
  readonly runtime: string;
  /** The server root, without `/v1`. */
  readonly url: string;
  readonly model: string;
}

export interface KeylessLocalInput {
  env: NodeJS.ProcessEnv;
  /** Which runtimes answer and what each has; defaults to the real endpoints. A test injects a fake. */
  discovery?: LocalDiscoveryPort;
  /** Picks the memory tier's model, as local setup does; defaults to `os.totalmem()`. */
  totalMemoryBytes?: number;
}

/**
 * [C9] What `trent setup --mode local` would choose with no flags and no pull, or undefined when that
 * command would stop. It is L2's own detection (`local-detect.ts`) and L2's own choices
 * (`local-plan.ts`: `chooseRuntime`, then `chooseChat`), so a suggestion is made only where the
 * suggested command then works, and never for an Ollama cloud model or a model its runtime lists
 * without `tools`. Only GET requests to the runtimes' listing routes: no key is sent, no model is called.
 */
export async function findKeylessLocal(input: KeylessLocalInput): Promise<KeylessLocal | undefined> {
  const probes = await (input.discovery ?? createLocalDiscovery()).detect({ env: input.env });
  const choice = chooseRuntime(probes, {});
  if (!choice.ok) return undefined;
  const chat = chooseChat(choice.runtime, { totalMemoryBytes: input.totalMemoryBytes ?? os.totalmem(), pull: false });
  if (chat.model === undefined) return undefined;
  return { runtime: RUNTIME_LABEL[choice.runtime.kind], url: choice.runtime.url, model: chat.model };
}

/** [C9] `Ollama at http://127.0.0.1:11434 has qwen3.5:9b`: the one phrase every surface uses. */
export function describeKeylessLocal(local: KeylessLocal): string {
  return `${local.runtime} at ${local.url} has ${local.model}`;
}

/**
 * The message shown when nothing was found. There is no hosted portal to sign into, so this names the
 * exact variables and the exact file instead of pretending to run an authorization flow. [C9] With a
 * `local` model that needs no key, the first thing it says is that model and the command that uses it.
 */
export function missingKeyGuidance(configManager: ConfigManager, local?: KeylessLocal): string[] { // [C9] local
  const lines = [
    ...(local === undefined ? [ // [C9]
      "No provider API key was found.",
      "Trent has no hosted sign-in. A key is read from one of two places:",
    ] : [
      "No provider API key was found, but a model on this machine needs none.",
      `${describeKeylessLocal(local)}. To use it, run: ${LOCAL_SETUP_COMMAND}`,
      "Or use a hosted provider. Trent has no hosted sign-in. A key is read from one of two places:",
    ]),
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
  lines.push(`For example: echo 'OPENAI_API_KEY=your-key' >> ${configManager.getSecretsPath()}`);
  // [C9] Unchanged when no local model was found; with one, the command above already leads.
  if (local === undefined) lines.push("Or run a model on this machine, which needs no key: trent setup --mode quick --provider ollama (or lmstudio)");
  return lines;
}

/** The variable a user should set for a provider, when we have to name exactly one. */
export function primaryEnvVar(provider: Provider): string {
  return PROVIDER_ENV_VARS[provider][0] ?? `${provider.toUpperCase()}_API_KEY`;
}
