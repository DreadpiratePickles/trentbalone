/**
 * Where the configured provider's model calls actually go, for the doctor (audit G13).
 *
 * The base URLs mirror what the runtime reads: an alias (`ollama`, `lmstudio`, `deepseek`, `groq`)
 * resolves through `model-gateway/providers.ts` `aliasBaseUrl`; the app's own clients read
 * `OPENAI_BASE_URL`, `GOOGLE_BASE_URL`, `MISTRAL_BASE_URL` and `OPENROUTER_BASE_URL` with the
 * defaults below (`apps/web/lib/ai-client.ts:116,171-185`) and send Anthropic to a fixed host
 * (`:199`). A value in the profile's `.env` counts, as it does at run time
 * (`ConfigManager.loadSecrets` exports it), and a variable already in the environment wins.
 */
import { aliasBaseUrl, resolveProviderAlias, type ProviderAliasRoute } from "../model-gateway/providers.js";
import type { DoctorContext } from "./types.js";

export interface ProviderEndpoint {
  readonly provider: string;
  /** The OpenAI-compatible base URL (or the Anthropic origin) the runtime sends model calls to. */
  readonly url: string;
  readonly host: string;
  /** True for a runtime on this machine (a local alias, or any loopback host). */
  readonly local: boolean;
  /** The variable that moves it, when one does. */
  readonly baseUrlEnv?: string;
  readonly alias?: ProviderAliasRoute;
}

const HOSTED: Readonly<Record<string, { env?: string; fallback: string }>> = {
  openai: { env: "OPENAI_BASE_URL", fallback: "https://api.openai.com/v1" },
  anthropic: { fallback: "https://api.anthropic.com" },
  google: { env: "GOOGLE_BASE_URL", fallback: "https://generativelanguage.googleapis.com/v1beta/openai/" },
  mistral: { env: "MISTRAL_BASE_URL", fallback: "https://api.mistral.ai/v1" },
  openrouter: { env: "OPENROUTER_BASE_URL", fallback: "https://openrouter.ai/api/v1" },
};

/** The profile's `.env` under the process environment. Names and values stay in memory only. */
export function doctorEnv(ctx: DoctorContext): NodeJS.ProcessEnv {
  let fromFile: Record<string, unknown> = {};
  try {
    fromFile = ctx.configManager.loadSecrets() as unknown as Record<string, unknown>;
  } catch {
    fromFile = {};
  }
  const merged: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(fromFile)) if (typeof value === "string" && value !== "") merged[name] = value;
  for (const [name, value] of Object.entries(ctx.env ?? process.env)) if (value !== undefined && value !== "") merged[name] = value;
  return merged;
}

export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

export function providerEndpoint(provider: string, env: NodeJS.ProcessEnv): ProviderEndpoint | undefined {
  const alias = resolveProviderAlias(provider);
  let url: string;
  let baseUrlEnv: string | undefined;
  if (alias !== undefined) {
    url = aliasBaseUrl(alias.alias, env);
    baseUrlEnv = alias.baseUrlEnv;
  } else {
    const hosted = HOSTED[provider];
    if (hosted === undefined) return undefined;
    const moved = hosted.env === undefined ? undefined : env[hosted.env]?.trim();
    url = moved !== undefined && moved !== "" ? moved : hosted.fallback;
    baseUrlEnv = hosted.env;
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  return {
    provider,
    url,
    host,
    local: (alias?.local ?? false) || isLoopbackHost(host),
    ...(baseUrlEnv === undefined ? {} : { baseUrlEnv }),
    ...(alias === undefined ? {} : { alias }),
  };
}
