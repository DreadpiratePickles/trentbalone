/**
 * The wrapper-side price table. `apps/web/lib/model-gateway.ts:194` prices every call by TIER
 * (haiku/sonnet/opus at Anthropic list), so a Gemini call routed through the "sonnet" tier is
 * billed at ~100x its list price. The table overlays a per-model-id price; unknown models keep
 * the tier price and say so on the meter row. Offline: no network, no keys.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import {
  MODEL_OVERRIDES_ENV,
  MODEL_PRICE_PREFIXES,
  MODEL_PRICE_TABLE,
  applyModelOverridesEnv,
  contextWindowFor,
  modelOverridesFromEnv,
  priceCall,
  priceRowFor,
} from "./pricing.js";
import type { GatewayStreamEvent, ProviderStreamFn } from "./types.js";

const MILLION = 1_000_000;
const tierDefault = () => 30_000; // what the Anthropic "sonnet" tier charges for 1M input tokens, in cents

describe("priceCall: the per-model overlay", () => {
  it("prices 1,000,000 input tokens on gemini-3.5-flash-lite from the flash-lite row, not the tier default", () => {
    const row = MODEL_PRICE_TABLE["gemini-3.5-flash-lite"];
    expect(row).toBeDefined();
    const priced = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    // $0.30 per 1M input tokens = 30 cents = 30,000,000 micro-cents per million.
    expect(row?.inputMicroCentsPerMillion).toBe(30_000_000);
    expect(priced.costCents).toBe(30);
    expect(priced.costCents).not.toBe(tierDefault());
    expect(priced.pricedAsDefault).toBe(false);
    expect(Number.isInteger(priced.costCents)).toBe(true);
  });

  it("rounds up to the next integer cent and never returns a float", () => {
    const priced = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: 1_000, outputTokens: 1_000 }, tierDefault);
    // 0.03 + 0.25 cents -> 1 cent.
    expect(priced.costCents).toBe(1);
    const zero = priceCall({ model: "gemini-3.5-flash", modelTier: "sonnet", inputTokens: 0, outputTokens: 0 }, tierDefault);
    expect(zero.costCents).toBe(0);
  });

  it("an unknown model falls back to the tier price, flagged priced_as_default AND unpriced", () => {
    const priced = priceCall({ model: "some-model-nobody-listed", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    expect(priced.costCents).toBe(tierDefault());
    expect(priced.pricedAsDefault).toBe(true);
    expect(priced.unpriced).toBe(true);
    expect(priced.source).toBe("default");
  });

  it("every row is integer micro-cents and names its source", () => {
    for (const [id, row] of Object.entries(MODEL_PRICE_TABLE)) {
      expect(Number.isInteger(row.inputMicroCentsPerMillion), id).toBe(true);
      expect(Number.isInteger(row.outputMicroCentsPerMillion), id).toBe(true);
      expect(row.source.length, id).toBeGreaterThan(0);
    }
    expect(Object.keys(MODEL_PRICE_TABLE)).toEqual(expect.arrayContaining(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro"]));
  });
});

function fakeProvider(inputTokens: number, outputTokens: number): ProviderStreamFn {
  return async function* () {
    yield { type: "token", content: "ok" };
    yield { type: "usage", inputTokens, outputTokens };
    yield { type: "finish", reason: "stop" };
  };
}

describe("the prefix table: the models we actually ship", () => {
  it("prices every family the config and the setup wizard can select", () => {
    const shipped = [
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "gpt-5.6-terra",
      "gpt-5.2-codex",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "mistral-large-latest",
      "mistral-small-latest",
      "deepseek-chat",
      "deepseek-reasoner",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ];
    for (const model of shipped) {
      expect(priceRowFor(model), model).toBeDefined();
      const priced = priceCall({ model, modelTier: "sonnet", inputTokens: MILLION, outputTokens: MILLION }, tierDefault);
      expect(priced.unpriced, model).toBe(false);
      expect(priced.pricedAsDefault, model).toBe(false);
      expect(Number.isInteger(priced.costCents), model).toBe(true);
    }
  });

  it("prices an OpenRouter pass-through by the model underneath the vendor prefix", () => {
    const direct = priceCall({ model: "claude-sonnet-4-6", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    const viaRouter = priceCall(
      { model: "anthropic/claude-sonnet-4-6", provider: "openrouter", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 },
      tierDefault,
    );
    expect(viaRouter.costCents).toBe(direct.costCents);
    expect(viaRouter.unpriced).toBe(false);
  });

  it("prices a local model at zero regardless of its id — nothing is billed for own hardware", () => {
    for (const alias of ["ollama", "lmstudio"] as const) {
      const priced = priceCall(
        { model: "whatever-someone-pulled:latest", alias, modelTier: "opus", inputTokens: MILLION, outputTokens: MILLION },
        tierDefault,
      );
      expect(priced.costCents, alias).toBe(0);
      expect(priced.unpriced, alias).toBe(false);
      expect(priced.source, alias).toBe("local");
    }
  });

  it("prefers the longest matching prefix and never guesses across providers", () => {
    const nano = priceCall({ model: "gpt-4.1-nano", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    const mini = priceCall({ model: "gpt-4.1-mini", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    expect(nano.costCents).toBeLessThan(mini.costCents);
    // A Groq-hosted open model must not be priced from an Anthropic or OpenAI rule.
    expect(priceRowFor("llama-3.3-70b-versatile", "groq")?.source).toContain("groq");
  });

  it("every prefix rule and table row is integer micro-cents, names a source, and explains itself when unverified", () => {
    const rows = [...Object.values(MODEL_PRICE_TABLE), ...MODEL_PRICE_PREFIXES.map((rule) => rule.row)];
    for (const row of rows) {
      expect(Number.isInteger(row.inputMicroCentsPerMillion)).toBe(true);
      expect(Number.isInteger(row.outputMicroCentsPerMillion)).toBe(true);
      expect(row.inputMicroCentsPerMillion).toBeGreaterThanOrEqual(0);
      expect(row.source.length).toBeGreaterThan(0);
      if (row.source === "unverified") expect(row.note, JSON.stringify(row)).toBeTruthy();
    }
  });
});

describe("model_overrides from config", () => {
  afterEach(() => {
    delete process.env[MODEL_OVERRIDES_ENV];
  });

  it("an override wins over the shipped table", () => {
    const overrides = { "gemini-3.5-flash-lite": { input_cents_per_million: 7, output_cents_per_million: 0 } };
    const priced = priceCall(
      { model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, outputTokens: MILLION, overrides },
      tierDefault,
    );
    expect(priced.costCents).toBe(7);
    expect(priced.source).toBe("override");
    expect(priced.unpriced).toBe(false);
  });

  it("an override prices a model the table has never heard of", () => {
    const overrides = { "my-private-finetune": { input_cents_per_million: 100, output_cents_per_million: 200 } };
    const priced = priceCall(
      { model: "my-private-finetune", modelTier: "sonnet", inputTokens: MILLION, outputTokens: MILLION, overrides },
      tierDefault,
    );
    expect(priced.costCents).toBe(300);
    expect(priced.unpriced).toBe(false);
  });

  it("a context-window-only override does not pretend to be a price", () => {
    const overrides = { "gemini-3.5-flash-lite": { context_window: 2_000_000 } };
    const priced = priceCall(
      { model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0, overrides },
      tierDefault,
    );
    expect(priced.costCents).toBe(30); // still the table row
    expect(contextWindowFor("gemini-3.5-flash-lite", undefined, overrides)).toBe(2_000_000);
  });

  it("travels to the gateway through the env bridge, the way the privacy block does", () => {
    const written = applyModelOverridesEnv({ "my-private-finetune": { input_cents_per_million: 1 } });
    expect(written).toEqual([MODEL_OVERRIDES_ENV]);
    expect(modelOverridesFromEnv()["my-private-finetune"]).toEqual({ input_cents_per_million: 1 });
    expect(process.env[MODEL_OVERRIDES_ENV]).not.toContain("api");
  });

  it("ignores a malformed env payload instead of throwing mid-run", () => {
    process.env[MODEL_OVERRIDES_ENV] = "{not json";
    expect(modelOverridesFromEnv()).toEqual({});
  });
});

describe("the gateway meter row carries the overlay", () => {
  it("a flash-lite usage row is priced from the table and flagged priced_as_default: false", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: "test-google-key" },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-3.5-flash-lite" },
      streamProvider: fakeProvider(MILLION, 0),
    });
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    const usage = events.find((e) => e.type === "usage");
    expect(usage?.type).toBe("usage");
    if (usage?.type !== "usage") return;
    expect(usage.model).toBe("gemini-3.5-flash-lite");
    expect(usage.costCents).toBe(30);
    expect(usage.priced_as_default).toBe(false);
    expect(usage.unpriced).toBe(false);
    expect(gateway.estimateCostCents({ modelTier: usage.modelTier, inputTokens: MILLION, outputTokens: 0 })).toBeGreaterThan(30);
  });

  it("flags a model nobody has priced as `unpriced` instead of passing an Anthropic-tier guess off as fact", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: "test-google-key" },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-experimental-unlisted-0000" },
      streamProvider: fakeProvider(MILLION, 0),
    });
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    const usage = events.find((e) => e.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage event");
    expect(usage.unpriced).toBe(true);
    expect(usage.priced_as_default).toBe(true);
  });

  it("takes model_overrides from the gateway config, and the override wins over the table", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: "test-google-key" },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-3.5-flash-lite" },
      modelOverrides: { "gemini-3.5-flash-lite": { input_cents_per_million: 5, output_cents_per_million: 0 } },
      streamProvider: fakeProvider(MILLION, 0),
    });
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    const usage = events.find((e) => e.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage event");
    expect(usage.costCents).toBe(5);
    expect(usage.unpriced).toBe(false);
  });
});
