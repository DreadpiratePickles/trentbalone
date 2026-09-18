/**
 * RED for D-7: the TUI model modal offered Ollama, DeepSeek and Groq while `applyModelEnv` returned
 * `unsupportedProvider: true` for all three and nobody read it — picking one produced a config Trent
 * accepted and a run that routed somewhere else. A modal entry must name a provider the config
 * accepts, a model the wizard would also pick, and a route that exists.
 */
import { describe, expect, it } from "vitest";

import { ProviderSchema } from "@trent/core/config/schema.js";
import { resolveProviderAlias } from "@trent/core/model-gateway/providers.js";
import { DEFAULT_MODELS } from "@trent/core/setup/detect.js";

import { MODEL_MODAL_PROVIDERS } from "../modals/ModelModal.js";

const APP_PROVIDERS = ["openai", "anthropic", "google", "mistral", "openrouter"];

describe("the TUI model modal", () => {
  it("offers only providers the config accepts and something can route", () => {
    expect(MODEL_MODAL_PROVIDERS.length).toBeGreaterThan(0);
    for (const entry of MODEL_MODAL_PROVIDERS) {
      expect(ProviderSchema.safeParse(entry.provider).success, entry.provider).toBe(true);
      const routable = APP_PROVIDERS.includes(entry.provider) || resolveProviderAlias(entry.provider) !== undefined;
      expect(routable, entry.provider).toBe(true);
    }
  });

  it("offers the local runtimes, which need no account at all", () => {
    const offered = MODEL_MODAL_PROVIDERS.map((entry) => entry.provider);
    expect(offered).toContain("ollama");
    expect(offered).toContain("lmstudio");
  });

  it("names a model the setup wizard would also write, so the two surfaces cannot disagree", () => {
    for (const entry of MODEL_MODAL_PROVIDERS) {
      expect(entry.model, entry.provider).toBe(DEFAULT_MODELS[entry.provider]);
    }
  });
});
