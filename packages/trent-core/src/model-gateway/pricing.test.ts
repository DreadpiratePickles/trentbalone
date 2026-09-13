/**
 * The wrapper-side price table. `apps/web/lib/model-gateway.ts:194` prices every call by TIER
 * (haiku/sonnet/opus at Anthropic list), so a Gemini call routed through the "sonnet" tier is
 * billed at ~100x its list price. The table overlays a per-model-id price; unknown models keep
 * the tier price and say so on the meter row. Offline: no network, no keys.
 */
import { describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import { MODEL_PRICE_TABLE, priceCall } from "./pricing.js";
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

  it("an unknown model falls back to the tier price with priced_as_default", () => {
    const priced = priceCall({ model: "some-model-nobody-listed", modelTier: "sonnet", inputTokens: MILLION, outputTokens: 0 }, tierDefault);
    expect(priced.costCents).toBe(tierDefault());
    expect(priced.pricedAsDefault).toBe(true);
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
    expect(gateway.estimateCostCents({ modelTier: usage.modelTier, inputTokens: MILLION, outputTokens: 0 })).toBeGreaterThan(30);
  });
});
