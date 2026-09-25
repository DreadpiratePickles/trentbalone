/**
 * [P2-8] The per-run spend meter the orchestrator installs.
 *
 *   - seat calls: the app's `executeSeatModel` still runs (prompt, parse, cache, provider loop), but
 *     the cost it returns — tier-priced by `estimateModelCostCents` — is replaced by the list price
 *     of the model that actually answered, as the run meter carries it;
 *   - planner and critic calls (the `createCompletion` port) and the wrapper's consolidator are
 *     metered on their own rows;
 *   - `consolidate_end` carries the orchestration charge, the frame every surface already reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import { closeRunScope, openRunScope } from "./run-hooks.js";
import { createSeatChatPort } from "./seat-gateway-port.js";
import type { SeatModelFn, SeatModelInput } from "./seat-guard.js";
import { createRunSpendMeter } from "./spend-meter.js";
import type { OrcEvent, SeatChatCompletionFn, SeatChatRequest } from "./types.js";

const FLASH_LITE = "gemini-3.5-flash-lite";
const RUN = "run_meter";

function completion(over: Partial<GatewayCompletion> = {}): GatewayCompletion {
  return {
    text: '{"toolCall":null,"summary":"ok"}',
    provider: "google",
    model: FLASH_LITE,
    modelTier: "sonnet",
    inputTokens: 40_000,
    outputTokens: 4_000,
    cachedInputTokens: 0,
    costCents: 3,
    estimated: false,
    priced_as_default: false,
    unpriced: false,
    finishReason: "stop",
    ...over,
  };
}

function gatewayAnswering(reply: (req: GatewayStreamRequest) => GatewayCompletion): ModelGateway {
  return {
    complete: async (req) => reply(req),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["google"], fallbackChain: ["google"], modelTier: "sonnet", explicitModel: FLASH_LITE, modelForProvider: () => FLASH_LITE }),
    configuredProviders: () => ["google"],
    estimateCostCents: () => 0,
  };
}

function seatRequest(model = FLASH_LITE): SeatChatRequest {
  return { model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "system", content: "seat" }, { role: "user", content: "go" }] };
}

/** What `executeSeatModel` does with a port: try each provider's model in turn, price by tier. */
function appExecutor(models: string[], opts: { tierCents?: number; cacheHit?: boolean } = {}): SeatModelFn {
  return async (input) => {
    const chat = input.createChatCompletion as SeatChatCompletionFn | undefined;
    if (opts.cacheHit || chat === undefined) return { output: { summary: "cached" }, model: models[0]!, tokens: 44_000, costCents: opts.tierCents ?? 18, fallback: false };
    for (const [index, model] of models.entries()) {
      try {
        const out = await chat(seatRequest(model));
        return { output: {}, model, tokens: out.usage?.total_tokens ?? 0, costCents: opts.tierCents ?? 18, fallback: index > 0 };
      } catch {
        /* the app logs and tries the next provider */
      }
    }
    return { output: { error: "all failed" }, model: models[0]!, tokens: 0, costCents: 0, fallback: true, error: "all failed" };
  };
}

function seatInput(chat: SeatChatCompletionFn | undefined, seat = "ceo", id = "s1"): SeatModelInput {
  return { subtask: { id, seat }, ...(chat === undefined ? {} : { createChatCompletion: chat }) };
}

function rows() {
  return currentSpendLedger()?.rows() ?? [];
}

describe("the run spend meter", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-spend-meter-"));
    installSpendLedger(openSpendLedger({ profileDir }));
    openRunScope([], RUN, { companyId: "co", objective: "tagline", surface: "run" });
  });

  afterEach(() => {
    closeRunScope([], RUN);
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("replaces the app's tier price with the answering model's list price (18 -> 3 cents)", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const port = createSeatChatPort(gatewayAnswering(() => completion()));
    const result = await meter.seatModel(appExecutor([FLASH_LITE]))(seatInput(port));
    expect(result.costCents).toBe(3);
    expect(result.model).toBe(FLASH_LITE);
    closeRunScope([], RUN);
    expect(rows()).toEqual([expect.objectContaining({ seat: "ceo", model: FLASH_LITE, cents: 3, inputTokens: 40_000, outputTokens: 4_000 })]);
  });

  it("leaves a result alone when the seat was answered by some other port (a test fake, an injected executor)", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const plain: SeatChatCompletionFn = async () => ({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    expect((await meter.seatModel(appExecutor([FLASH_LITE]))(seatInput(plain))).costCents).toBe(18);
    expect((await meter.seatModel(appExecutor([FLASH_LITE]))(seatInput(undefined))).costCents).toBe(18);
    closeRunScope([], RUN);
    expect(rows()).toEqual([]);
  });

  it("charges nothing when the app replays its cached result: the same object, and no provider was asked", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const port = createSeatChatPort(gatewayAnswering(() => completion()));
    // `executeSeatModel` caches the object it returned and hands the same object back on a hit.
    let cached: Awaited<ReturnType<SeatModelFn>> | undefined;
    const caching: SeatModelFn = async (input) => (cached ??= await appExecutor([FLASH_LITE])(input));
    expect((await meter.seatModel(caching)(seatInput(port, "analyst", "s1"))).costCents).toBe(3);
    expect((await meter.seatModel(caching)(seatInput(port, "analyst", "s2"))).costCents).toBe(0);
  });

  it("keeps an injected executor's own figure when it never calls the port it was handed", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const port = createSeatChatPort(gatewayAnswering(() => completion()));
    const result = await meter.seatModel(appExecutor([FLASH_LITE], { cacheHit: true }))(seatInput(port));
    expect(result.costCents).toBe(18);
  });

  it("meters only the attempt that answered when the app's loop falls through an unconfigured provider", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const answered: string[] = [];
    const port = createSeatChatPort(gatewayAnswering((req) => (answered.push(req.model ?? ""), completion({ model: "gemini-3.6-flash", inputTokens: 1_000, outputTokens: 1_000 }))));
    const result = await meter.seatModel(appExecutor(["claude-sonnet-4-6", FLASH_LITE]))(seatInput(port, "engineer", "s2"));
    expect(answered).toEqual([FLASH_LITE]);
    // The gateway may answer with another model (fallback_on_pin): the row and the result name it.
    expect(result.model).toBe("gemini-3.6-flash");
    expect(result.costCents).toBe(1); // 1,000 x $0.75/1M + 1,000 x $3.75/1M = 0.45 of a cent
    closeRunScope([], RUN);
    expect(rows()).toEqual([expect.objectContaining({ seat: "engineer", model: "gemini-3.6-flash", cents: 1 })]);
  });

  it("labels the port's calls planner before the first seat call and critic after, and the consolidator its own", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const small = (): GatewayCompletion => completion({ inputTokens: 5_000, outputTokens: 1_000 });
    await meter.portGateway(gatewayAnswering(small)).complete({ messages: [] });
    await meter.seatModel(appExecutor([FLASH_LITE]))(seatInput(createSeatChatPort(gatewayAnswering(small))));
    await meter.portGateway(gatewayAnswering(small)).complete({ messages: [] });
    await meter.consolidatorGateway(gatewayAnswering(small)).complete({ messages: [] });
    closeRunScope([], RUN);
    expect(rows().map((row) => row.seat).sort()).toEqual(["ceo", "consolidator", "critic", "planner"]);
  });

  it("does not meter a gateway call that failed", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const failing: ModelGateway = { ...gatewayAnswering(() => completion()), complete: async () => { throw new Error("429"); } };
    await expect(meter.portGateway(failing).complete({ messages: [] })).rejects.toThrow("429");
    closeRunScope([], RUN);
    expect(rows()).toEqual([]);
  });

  it("puts the orchestration charge on consolidate_end, once, and leaves every other frame alone", async () => {
    const meter = createRunSpendMeter(() => RUN);
    await meter.portGateway(gatewayAnswering(() => completion({ inputTokens: 5_000, outputTokens: 1_000 }))).complete({ messages: [] });
    await meter.consolidatorGateway(gatewayAnswering(() => completion({ inputTokens: 3_000, outputTokens: 500 }))).complete({ messages: [] });
    const stepEnd: OrcEvent = { kind: "step_end", runId: RUN, at: "t", step: { id: "s1", costCents: 3 } };
    expect(meter.stamp(stepEnd)).toBe(stepEnd);
    const consolidated: OrcEvent = { kind: "consolidate_end", runId: RUN, at: "t", run: { summary: "brief" } };
    // 0.40 + 0.215 = 0.615 of a cent -> 1, with the 9,500 tokens it took.
    expect(meter.stamp(consolidated)).toEqual({ ...consolidated, step: { costCents: 1, tokens: 9_500 } });
    expect(meter.stamp(consolidated)).toBe(consolidated);
  });

  it("stamps nothing on consolidate_end when no orchestration call was metered", () => {
    const meter = createRunSpendMeter(() => RUN);
    const consolidated: OrcEvent = { kind: "consolidate_end", runId: RUN, at: "t" };
    expect(meter.stamp(consolidated)).toBe(consolidated);
  });
});
