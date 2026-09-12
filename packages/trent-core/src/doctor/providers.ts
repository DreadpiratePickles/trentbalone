import { classifyProbe, probeHttp, type ProbeOptions, type ProbeOutcome } from "./probe.js";

/**
 * Credential shape rules and the cheapest authenticated request each provider offers.
 *
 * The audit found a 16-character `sk-ant-` placeholder passing as `ok` because the old check tested
 * only that the string was non-empty. A prefix alone is no better: the placeholder has the prefix.
 * Shape validation is therefore prefix AND a plausible length, and shape validation alone is never
 * enough to report `ok` — a live authenticated call decides that.
 */

export const ANTHROPIC_MIN_KEY_LENGTH = 40;
export const OPENAI_MIN_KEY_LENGTH = 40;
export const GOOGLE_KEY_LENGTH = 39;
/** AI Studio's newer "AQ." keys are longer and variable length. */
export const GOOGLE_NEW_MIN_KEY_LENGTH = 30;
export const GENERIC_MIN_KEY_LENGTH = 20;

export interface ShapeVerdict {
  valid: boolean;
  /** Human-readable reason. Never contains the key. */
  reason?: string;
}

export interface ProviderCredential {
  id: string;
  label: string;
  /** Accepted environment variable names, most specific first. */
  envVars: readonly string[];
  validateShape(key: string): ShapeVerdict;
  probe(key: string, signal?: AbortSignal, options?: ProbeOptions): Promise<ProbeOutcome>;
}

function article(label: string): string {
  return /^[AEIOU]/i.test(label) ? "an" : "a";
}

function shapeCheck(
  key: string,
  label: string,
  prefix: string | undefined,
  minLength: number,
  exactLength?: number,
): ShapeVerdict {
  const trimmed = key.trim();
  if (trimmed.length === 0) return { valid: false, reason: `${label} key is empty` };
  if (prefix && !trimmed.startsWith(prefix)) {
    return { valid: false, reason: `${label} keys start with "${prefix}"` };
  }
  if (exactLength !== undefined && trimmed.length !== exactLength) {
    return {
      valid: false,
      reason: `key is ${trimmed.length} characters; ${article(label)} ${label} key is exactly ${exactLength}`,
    };
  }
  if (trimmed.length < minLength) {
    return {
      valid: false,
      reason: `key is ${trimmed.length} characters; ${article(label)} ${label} key is at least ${minLength}. This looks like a placeholder`,
    };
  }
  return { valid: true };
}

/** Probe helper: build the request, run it under a deadline, classify the status. */
async function httpProbe(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  options: ProbeOptions | undefined,
): Promise<ProbeOutcome> {
  return classifyProbe(await probeHttp(url, init, { ...options, signal }));
}

const anthropic: ProviderCredential = {
  id: "anthropic",
  label: "Anthropic",
  envVars: ["ANTHROPIC_API_KEY"],
  validateShape: (key) => shapeCheck(key, "Anthropic", "sk-ant-", ANTHROPIC_MIN_KEY_LENGTH),
  probe: (key, signal, options) =>
    // The cheapest authenticated call Anthropic offers: a one-token completion.
    httpProbe(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: 1,
          messages: [{ role: "user", content: "." }],
        }),
      },
      signal,
      options,
    ),
};

const openai: ProviderCredential = {
  id: "openai",
  label: "OpenAI",
  envVars: ["OPENAI_API_KEY"],
  validateShape: (key) => shapeCheck(key, "OpenAI", "sk-", OPENAI_MIN_KEY_LENGTH),
  probe: (key, signal, options) =>
    httpProbe(
      "https://api.openai.com/v1/models",
      { method: "GET", headers: { authorization: `Bearer ${key}` } },
      signal,
      options,
    ),
};

const google: ProviderCredential = {
  id: "google",
  label: "Google Gemini",
  envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  // Two live formats: the legacy 39-character "AIza" key and the newer AI Studio "AQ." key.
  validateShape: (key) =>
    key.trim().startsWith("AQ.")
      ? shapeCheck(key, "Google Gemini", "AQ.", GOOGLE_NEW_MIN_KEY_LENGTH)
      : shapeCheck(key, "Google Gemini", "AIza", GOOGLE_KEY_LENGTH, GOOGLE_KEY_LENGTH),
  probe: (key, signal, options) =>
    // The key travels in a header, never in the query string, so it cannot land in a proxy log.
    httpProbe(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { method: "GET", headers: { "x-goog-api-key": key } },
      signal,
      options,
    ),
};

function bearerProvider(
  id: string,
  label: string,
  envVar: string,
  url: string,
  prefix?: string,
): ProviderCredential {
  return {
    id,
    label,
    envVars: [envVar],
    validateShape: (key) => shapeCheck(key, label, prefix, GENERIC_MIN_KEY_LENGTH),
    probe: (key, signal, options) =>
      httpProbe(url, { method: "GET", headers: { authorization: `Bearer ${key}` } }, signal, options),
  };
}

export const PROVIDER_CREDENTIALS: Readonly<Record<string, ProviderCredential>> = {
  anthropic,
  openai,
  google,
  mistral: bearerProvider("mistral", "Mistral", "MISTRAL_API_KEY", "https://api.mistral.ai/v1/models"),
  openrouter: bearerProvider(
    "openrouter",
    "OpenRouter",
    "OPENROUTER_API_KEY",
    "https://openrouter.ai/api/v1/key",
    "sk-or-",
  ),
  deepseek: bearerProvider(
    "deepseek",
    "DeepSeek",
    "DEEPSEEK_API_KEY",
    "https://api.deepseek.com/models",
    "sk-",
  ),
  groq: bearerProvider("groq", "Groq", "GROQ_API_KEY", "https://api.groq.com/openai/v1/models", "gsk_"),
};

/** Providers that run locally and need no credential at all. */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(["ollama"]);

export function credentialForProvider(provider: string): ProviderCredential | undefined {
  return PROVIDER_CREDENTIALS[provider];
}
