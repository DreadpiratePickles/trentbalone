/**
 * [CF] C14.1: the RUN LEDGER prices Anthropic prompt-cache WRITES at the write rate.
 *
 * C14 taught the gateway's own `costCents` the 5-minute write (1.25x base input,
 * https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-26), but the run meter re-prices every
 * call from its tokens (`run-hooks.ts` `recordRunModelCall`) and `RunModelCall` carried no write count, so a
 * written token was billed at the base input rate: 0.25x low on every written token. The write count now travels
 * on `RunModelCall` from both of the meter's sources (`spend-meter.ts` `modelCall`: a gateway completion, and a
 * seat port call's usage). claude-sonnet-4-6 lists $3.00 per million input: 1M written = $3.75 = 375 cents.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayCompletion, ModelGateway } from "../model-gateway/types.js";
import { closeRunScope, openRunScope, recordRunModelCall, takeOrchestrationCharge } from "./run-hooks.js";
import { createSeatChatPort } from "./seat-gateway-port.js";
import type { SeatModelFn } from "./seat-guard.js";
import { createRunSpendMeter } from "./spend-meter.js";
import type { SeatChatCompletionFn } from "./types.js";

const RUN = "run_cf_cache_write";
const SONNET = "claude-sonnet-4-6";
const MILLION = 1_000_000;

function written(over: Partial<GatewayCompletion> = {}): GatewayCompletion {
  return {
    text: '{"toolCall":null,"summary":"ok"}',
    provider: "anthropic",
    model: SONNET,
    modelTier: "sonnet",
    inputTokens: MILLION,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: MILLION,
    costCents: 375,
    estimated: false,
    priced_as_default: false,
    unpriced: false,
    finishReason: "stop",
    ...over,
  };
}

function gatewayAnswering(reply: () => GatewayCompletion): ModelGateway {
  return {
    complete: async () => reply(),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["anthropic"], fallbackChain: ["anthropic"], modelTier: "sonnet", explicitModel: SONNET, modelForProvider: () => SONNET }),
    configuredProviders: () => ["anthropic"],
    estimateCostCents: () => 0,
  };
}

/** The app's executor, reduced: one port call on the seat's model. */
const oneCall: SeatModelFn = async (input) => {
  const chat = input.createChatCompletion as SeatChatCompletionFn;
  const out = await chat({ model: SONNET, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: "seat" }, { role: "user", content: "go" }] });
  return { output: {}, model: SONNET, tokens: out.usage?.total_tokens ?? 0, costCents: 18, fallback: false };
};

describe("[CF] the run ledger prices cache writes at 1.25x input", () => {
  beforeEach(() => openRunScope([], RUN, { companyId: "co", objective: "cache", surface: "run" }));
  afterEach(() => closeRunScope([], RUN));

  it("a usage row with 1M written tokens on claude-sonnet-4-6 is 375 cents, not 300 at the base rate", () => {
    const cents = recordRunModelCall(RUN, { seat: "trent", stepId: "s1", model: SONNET, provider: "anthropic", inputTokens: MILLION, cachedInputTokens: 0, cacheWriteInputTokens: MILLION, outputTokens: 0, estimated: false, costCents: 0 });
    expect(cents).toBe(375);
  });

  it("the meter's gateway call passes the completion's write count: the orchestration charge is 375 cents", async () => {
    const meter = createRunSpendMeter(() => RUN);
    await meter.consolidatorGateway(gatewayAnswering(() => written())).complete({ messages: [{ role: "user", content: "x" }] });
    expect(takeOrchestrationCharge(RUN)?.cents).toBe(375);
  });

  it("a seat call through the wrapper's port passes it too: the step is charged 375 cents", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const result = await meter.seatModel(oneCall)({ subtask: { id: "s1", seat: "ceo" }, createChatCompletion: createSeatChatPort(gatewayAnswering(() => written())) });
    expect(result.costCents).toBe(375);
  });
});
