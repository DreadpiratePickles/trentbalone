/**
 * RED for D-7: "`ollama`, `deepseek` and `groq` are accepted everywhere and routed nowhere."
 *
 * This is the guard that keeps the four surfaces in step. Every name `ProviderSchema` accepts must
 * be routable — either a provider identity the wrapped app understands, or an alias that resolves
 * to one — and the setup wizard, the doctor and the config defaults must all know it. A provider
 * that exists only in the enum is the defect this file exists to fail on.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "./defaults.js";
import { ProviderSchema, TrentConfigSchema } from "./schema.js";
import { KEYLESS_ALIASES, PROVIDER_ALIASES, resolveProviderAlias } from "../model-gateway/providers.js";
import { KEYLESS_PROVIDERS, credentialForProvider } from "../doctor/providers.js";
import { DEFAULT_MODELS, PROVIDER_ENV_VARS } from "../setup/detect.js";

const APP_PROVIDERS = ["openai", "anthropic", "google", "mistral", "openrouter"];

describe("the provider enum", () => {
  it("accepts the five app providers and the four OpenAI-compatible aliases, and nothing else", () => {
    expect([...ProviderSchema.options].sort()).toEqual(
      [...APP_PROVIDERS, ...PROVIDER_ALIASES].sort(),
    );
  });

  it("routes every accepted provider somewhere real", () => {
    for (const provider of ProviderSchema.options) {
      const routable = APP_PROVIDERS.includes(provider) || resolveProviderAlias(provider) !== undefined;
      expect(routable, provider).toBe(true);
    }
  });

  it("gives every accepted provider a setup default and a credential rule or a keyless exemption", () => {
    for (const provider of ProviderSchema.options) {
      expect(PROVIDER_ENV_VARS[provider], provider).toBeDefined();
      expect(DEFAULT_MODELS[provider]?.length, provider).toBeGreaterThan(0);
      const covered = KEYLESS_PROVIDERS.has(provider) || credentialForProvider(provider) !== undefined;
      expect(covered, provider).toBe(true);
    }
  });

  it("derives the doctor's keyless set from the alias registry instead of a second hand-kept list", () => {
    for (const alias of KEYLESS_ALIASES) expect(KEYLESS_PROVIDERS.has(alias), alias).toBe(true);
    for (const provider of KEYLESS_PROVIDERS) expect(PROVIDER_ENV_VARS[provider as "ollama"]).toEqual([]);
  });
});

describe("model_overrides", () => {
  it("defaults to an empty map so an untouched config prices from the shipped table", () => {
    expect(TrentConfigSchema.parse({}).model_overrides).toEqual({});
    expect(DEFAULT_CONFIG.model_overrides).toEqual({});
  });

  it("parses a per-model price and context window", () => {
    const parsed = TrentConfigSchema.parse({
      model_overrides: {
        "gemini-3.5-flash-lite": { input_cents_per_million: 30, output_cents_per_million: 250, context_window: 1_000_000 },
        "my-private-finetune": { input_cents_per_million: 0 },
      },
    });
    expect(parsed.model_overrides["gemini-3.5-flash-lite"]).toEqual({
      input_cents_per_million: 30,
      output_cents_per_million: 250,
      context_window: 1_000_000,
    });
    expect(parsed.model_overrides["my-private-finetune"]).toEqual({ input_cents_per_million: 0 });
  });

  it("refuses a negative price and a zero context window rather than billing from nonsense", () => {
    expect(() => TrentConfigSchema.parse({ model_overrides: { m: { input_cents_per_million: -1 } } })).toThrow();
    expect(() => TrentConfigSchema.parse({ model_overrides: { m: { context_window: 0 } } })).toThrow();
  });
});
