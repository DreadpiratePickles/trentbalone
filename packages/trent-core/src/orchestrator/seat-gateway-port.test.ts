/**
 * [P2-8] The seat port: the app's `executeSeatModel` accepts a `createChatCompletion` in place of its
 * own provider client (`apps/web/lib/model-gateway.ts:84`, `:238-241`), and the wrapper already
 * forwards one through the seat guard. Until now production passed none, so every seat call went
 * through the app's client and was priced by tier. This port answers each attempt through the
 * wrapper's model gateway instead: real usage (cached tokens included), the call's model pinned,
 * and the gateway's own priced record riding back for the meter.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ALIAS_ENV } from "../model-gateway/providers.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway, ModelProvider } from "../model-gateway/types.js";
import { createSeatChatPort, isMeteredSeatPort, readSeatCallUsage, SEAT_JSON_INSTRUCTION } from "./seat-gateway-port.js";
import type { SeatChatRequest } from "./types.js";

const FLASH_LITE = "gemini-3.5-flash-lite";

function fakeGateway(options: { configured?: ModelProvider[]; reply?: Partial<GatewayCompletion>; fail?: string } = {}) {
  const requests: GatewayStreamRequest[] = [];
  const gateway: ModelGateway = {
    complete: async (req) => {
      requests.push(req);
      if (options.fail !== undefined) throw new Error(options.fail);
      return {
        text: 'Sure:\n```json\n{"toolCall":null,"summary":"Warm bread at 6 am."}\n```',
        provider: "google",
        model: FLASH_LITE,
        modelTier: "sonnet",
        inputTokens: 40_000,
        outputTokens: 4_000,
        cachedInputTokens: 10_000,
        costCents: 2,
        estimated: false,
        priced_as_default: false,
        unpriced: false,
        finishReason: "stop",
        ...options.reply,
      };
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("the seat port uses complete()");
    },
    resolveRoute: () => ({ providers: ["google"], fallbackChain: ["google"], modelTier: "sonnet", explicitModel: FLASH_LITE, modelForProvider: () => FLASH_LITE }),
    configuredProviders: () => options.configured ?? ["google"],
    estimateCostCents: () => 0,
  };
  return { gateway, requests };
}

function seatRequest(model = FLASH_LITE): SeatChatRequest {
  return {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are the CEO seat." },
      { role: "user", content: "Company: Bakery\nSeat: ceo\nObjective: a tagline" },
    ],
  };
}

describe("the seat port answers through the wrapper's model gateway", () => {
  it("pins the model the app resolved, keeps its temperature, and asks for JSON in the system message", async () => {
    const { gateway, requests } = fakeGateway();
    await createSeatChatPort(gateway)(seatRequest());
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.model).toBe(FLASH_LITE);
    expect(req.provider).toBeUndefined(); // the gateway infers it, so `fallback_on_pin` governs the attempt
    expect(req.role).toBe("executor");
    expect(req.temperature).toBe(0.2);
    expect(req.maxTokens).toBe(8192); // the app's MAX_TOKENS.JSON default for a seat call
    expect(req.messages[0]).toEqual({ role: "system", content: `You are the CEO seat.\n\n${SEAT_JSON_INSTRUCTION}` });
    expect(req.messages[1]).toEqual({ role: "user", content: "Company: Bakery\nSeat: ceo\nObjective: a tagline" });
  });

  it("returns the JSON object alone and the gateway's REAL usage, cached tokens included", async () => {
    const { gateway } = fakeGateway();
    const out = await createSeatChatPort(gateway)(seatRequest());
    expect(out.choices[0]?.message.content).toBe('{"toolCall":null,"summary":"Warm bread at 6 am."}');
    expect(out.usage).toEqual({
      prompt_tokens: 40_000,
      completion_tokens: 4_000,
      total_tokens: 44_000,
      prompt_tokens_details: { cached_tokens: 10_000 },
    });
  });

  it("carries the gateway's own record of the call for the meter, and a plain reply carries none", async () => {
    const { gateway } = fakeGateway({ reply: { estimated: true, providerAlias: undefined } });
    const out = await createSeatChatPort(gateway)(seatRequest());
    expect(readSeatCallUsage(out)).toEqual({
      model: FLASH_LITE,
      provider: "google",
      inputTokens: 40_000,
      outputTokens: 4_000,
      cachedInputTokens: 10_000,
      costCents: 2,
      estimated: true,
      unpriced: false,
    });
    expect(readSeatCallUsage({ choices: [{ message: { content: "{}" } }] })).toBeUndefined();
    expect(readSeatCallUsage(undefined)).toBeUndefined();
  });

  it("refuses a provider this profile has no key for WITHOUT a network call, so the app's loop moves on", async () => {
    const { gateway, requests } = fakeGateway({ configured: ["google"] });
    await expect(createSeatChatPort(gateway)(seatRequest("claude-sonnet-4-6"))).rejects.toThrow(/anthropic is not configured/);
    await expect(createSeatChatPort(gateway)(seatRequest("anthropic/claude-sonnet-4-6"))).rejects.toThrow(/openrouter is not configured/);
    expect(requests).toEqual([]);
  });

  it("lets a model whose provider it cannot name through to the gateway (an alias model routes there)", async () => {
    const { gateway, requests } = fakeGateway({ configured: ["openai"] });
    await createSeatChatPort(gateway)(seatRequest("llama3.2"));
    expect(requests[0]?.model).toBe("llama3.2");
  });

  it("propagates a provider failure as a throw, which is what the app's loop and the seat guard count", async () => {
    const { gateway } = fakeGateway({ fail: "google 503: overloaded" });
    await expect(createSeatChatPort(gateway)(seatRequest())).rejects.toThrow("google 503: overloaded");
  });

  it("returns a null content for an empty reply rather than inventing one", async () => {
    const { gateway } = fakeGateway({ reply: { text: "   " } });
    const out = await createSeatChatPort(gateway)(seatRequest());
    expect(out.choices[0]?.message.content).toBeNull();
  });

  it("is recognisable as the metering port; any other chat function is not", () => {
    const { gateway } = fakeGateway();
    expect(isMeteredSeatPort(createSeatChatPort(gateway))).toBe(true);
    expect(isMeteredSeatPort(async () => ({ choices: [] }))).toBe(false);
    expect(isMeteredSeatPort(undefined)).toBe(false);
  });
});

// [L0-1] G4 (local-path audit 2026-09-26): under `provider: ollama` a seat model whose id contains
// "mistral", "gemini" or "claude" was refused by name ("mistral is not configured"), and the same name
// sent through the gateway reached api.mistral.ai. Under a provider alias the port routes by provider.
describe("[L0-1] under a provider alias the seat port never judges a model by its name", () => {
  const before = process.env[ALIAS_ENV];
  afterEach(() => {
    if (before === undefined) delete process.env[ALIAS_ENV];
    else process.env[ALIAS_ENV] = before;
  });

  it("accepts every local model id as a seat, whatever it contains, and leaves the provider to the alias", async () => {
    process.env[ALIAS_ENV] = "ollama";
    const { gateway, requests } = fakeGateway({ configured: ["openai"] });
    const ids = ["mistral:7b", "gemini-distill:2b", "claude-local:8b", "anthropic/claude-q4:latest", "gpt-oss:20b"];
    for (const id of ids) await createSeatChatPort(gateway)(seatRequest(id));
    expect(requests.map((req) => req.model)).toEqual(ids);
    expect(requests.every((req) => req.provider === undefined)).toBe(true);
  });

  it("without an alias the name rule still refuses a provider this profile has no key for", async () => {
    delete process.env[ALIAS_ENV];
    const { gateway, requests } = fakeGateway({ configured: ["openai"] });
    await expect(createSeatChatPort(gateway)(seatRequest("mistral-large-latest"))).rejects.toThrow(/mistral is not configured/);
    expect(requests).toEqual([]);
  });
});
