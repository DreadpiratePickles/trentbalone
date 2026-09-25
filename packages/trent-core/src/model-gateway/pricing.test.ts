/**
 * The wrapper-side price table. `apps/web/lib/model-gateway.ts:194` prices every call by TIER
 * (haiku/sonnet/opus at Anthropic list), so a Gemini call routed through the "sonnet" tier is
 * billed at ~100x its list price. The table overlays a per-model-id price; unknown models keep
 * the tier price and say so on the meter row. Offline: no network, no keys.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import {
  DEFAULT_CACHED_INPUT_RATIO,
  MODEL_OVERRIDES_ENV,
  MODEL_PRICE_PREFIXES,
  MODEL_PRICE_TABLE,
  applyModelOverridesEnv,
  contextWindowFor,
  modelOverridesFromEnv,
  priceCall,
  priceCallMicroCents,
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

describe("[P1-C] cached prompt tokens are priced at the row's cached ratio", () => {
  it("the Gemini rows carry the cached ratio from Google's pricing page; every other row the 0.25 default", () => {
    // https://ai.google.dev/gemini-api/docs/pricing, read 2026-09-25: flash-lite $0.30 in, $0.03 cached.
    expect(DEFAULT_CACHED_INPUT_RATIO).toBe(0.25);
    for (const id of ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-pro", "gemini-2.5-flash"]) {
      expect(MODEL_PRICE_TABLE[id]?.cachedInputRatio, id).toBe(0.1);
    }
    expect(priceRowFor("claude-sonnet-4-6")?.cachedInputRatio).toBeUndefined();
  });

  it("prices 800k cached of 1M input on flash-lite at 9 cents, not the 30 a full-rate bill says", () => {
    const priced = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, cachedInputTokens: 800_000, outputTokens: 0 }, tierDefault);
    // 200k x $0.30/1M = 6.0 cents, 800k x $0.03/1M = 2.4 cents -> 8.4 -> 9 (rounded up, integer).
    expect(priced.costCents).toBe(9);
    const full = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    expect(full.costCents).toBe(30);
  });

  it("a row with no ratio of its own prices cached tokens at the default, and so does the tier fallback", () => {
    const sonnet = priceCall({ model: "claude-sonnet-4-6", modelTier: "sonnet", inputTokens: MILLION, cachedInputTokens: MILLION, outputTokens: 0 }, tierDefault);
    expect(sonnet.costCents).toBe(75); // $3.00/1M x 0.25
    const seen: number[] = [];
    const unpriced = priceCall(
      { model: "some-model-nobody-listed", modelTier: "sonnet", inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 0 },
      (input) => {
        seen.push(input.inputTokens);
        return 1;
      },
    );
    expect(seen).toEqual([400]); // 200 uncached + 800 x 0.25
    expect(unpriced.unpriced).toBe(true);
  });

  it("an override keeps the model's cached ratio, and a cached count above the prompt is clamped to it", () => {
    const overrides = { "gemini-3.5-flash-lite": { input_cents_per_million: 100, output_cents_per_million: 0 } };
    const priced = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, cachedInputTokens: MILLION, outputTokens: 0, overrides }, tierDefault);
    expect(priced.costCents).toBe(10);
    const clamped = priceCall({ model: "gemini-3.5-flash-lite", modelTier: "sonnet", inputTokens: MILLION, cachedInputTokens: 5 * MILLION, outputTokens: 0 }, tierDefault);
    expect(clamped.costCents).toBe(3);
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

/**
 * [P2-8] Exact micro-cents for one call, so a meter that adds up many sub-cent calls can round ONCE
 * instead of once per call (a 10-call flash-lite run otherwise meters ~10 cents for ~1 cent of list).
 */
describe("priceCallMicroCents — the exact list price before any rounding", () => {
  it("prices gemini-3.5-flash-lite at $0.30 in / $2.50 out per million, with no rounding", () => {
    // 40,000 x $0.30/1M = 1.2 cents; 4,000 x $2.50/1M = 1.0 cent.
    expect(priceCallMicroCents({ model: "gemini-3.5-flash-lite", inputTokens: 40_000, outputTokens: 4_000 })).toEqual({
      microCents: 2_200_000,
      source: "google-list-2026-09",
    });
    // One tagline-sized call: 1,000 in, 200 out = 0.03 + 0.05 cents.
    expect(priceCallMicroCents({ model: "gemini-3.5-flash-lite", inputTokens: 1_000, outputTokens: 200 })?.microCents).toBe(80_000);
  });

  it("prices the cached share at the row's cached ratio (a tenth on Gemini)", () => {
    // 30,000 uncached x 30 + 10,000 cached x 3 + 4,000 out x 250 micro-cents per token.
    expect(
      priceCallMicroCents({ model: "gemini-3.5-flash-lite", inputTokens: 40_000, outputTokens: 4_000, cachedInputTokens: 10_000 })?.microCents,
    ).toBe(1_930_000);
  });

  it("agrees with priceCall once rounded up, for priced rows, overrides and local aliases", () => {
    const cases = [
      { model: "gemini-3.5-flash-lite", inputTokens: 13_677, outputTokens: 411 },
      { model: "gemini-3.6-flash", inputTokens: 10_543, outputTokens: 142, cachedInputTokens: 8_164 },
      { model: "claude-sonnet-4-6", inputTokens: 2_000, outputTokens: 700 },
      { model: "my-model", inputTokens: 1_000_000, outputTokens: 0, overrides: { "my-model": { input_cents_per_million: 7 } } },
    ];
    for (const call of cases) {
      const micro = priceCallMicroCents(call);
      expect(micro).toBeDefined();
      expect(Math.ceil((micro?.microCents ?? 0) / 1_000_000)).toBe(priceCall({ ...call, modelTier: "sonnet" }, () => 999).costCents);
    }
    expect(priceCallMicroCents({ model: "llama3.2", alias: "ollama", inputTokens: 5_000, outputTokens: 5_000 })).toEqual({ microCents: 0, source: "local" });
    expect(priceCallMicroCents({ model: "my-model", inputTokens: 1_000_000, outputTokens: 0, overrides: { "my-model": { input_cents_per_million: 7 } } })).toEqual({
      microCents: 7_000_000,
      source: "override",
    });
  });

  it("returns nothing for a model no row, prefix or override prices, so the caller keeps the tier figure and says so", () => {
    expect(priceCallMicroCents({ model: "totally-unknown-model", inputTokens: 100, outputTokens: 100 })).toBeUndefined();
  });

  it("is always a whole number of micro-cents, rounded up, never below the bill", () => {
    // $0.075 cached rate on 3.6-flash is 7.5 micro-cents per token: 3 cached tokens = 22.5 -> 23.
    const micro = priceCallMicroCents({ model: "gemini-3.6-flash", inputTokens: 3, outputTokens: 0, cachedInputTokens: 3 });
    expect(micro?.microCents).toBe(23);
    expect(Number.isInteger(micro?.microCents)).toBe(true);
  });
});
