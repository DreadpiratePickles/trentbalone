/**
 * [L1] The one re-ask of a constrained seat turn is a model call of its own, so the run meter records
 * it: on a turn the re-ask saved, and on a turn that still failed (`SeatTurnError`), where the app
 * catches the throw and nothing else would carry what the two calls spent. The day's ledger groups calls
 * by seat, model and provider, so both calls' tokens land in the seat's row.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import { ALIAS_ENV } from "../model-gateway/providers.js";
import type { GatewayCompletion, ModelGateway } from "../model-gateway/types.js";
import { closeRunScope, openRunScope } from "./run-hooks.js";
import { createSeatChatPort } from "./seat-gateway-port.js";
import type { SeatModelFn, SeatModelInput } from "./seat-guard.js";
import { createRunSpendMeter } from "./spend-meter.js";
import type { SeatChatCompletionFn } from "./types.js";

const RUN = "run_reask";
const MODEL = "qwen3.5:9b";

function scripted(texts: string[]): ModelGateway {
  return {
    complete: async (): Promise<GatewayCompletion> => ({
      text: texts.shift() ?? "", provider: "openai", model: MODEL, modelTier: "sonnet", inputTokens: 3_000, outputTokens: 40,
      cachedInputTokens: 0, costCents: 0, estimated: false, priced_as_default: false, unpriced: false, providerAlias: "ollama", finishReason: "stop",
    }),
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["openai"], fallbackChain: ["openai"], modelTier: "sonnet", explicitModel: MODEL, modelForProvider: () => MODEL }),
    configuredProviders: () => ["openai"],
    estimateCostCents: () => 0,
  };
}

/** The app's executor: one attempt through the port, a throw caught and returned as the seat's error. */
const appExecutor: SeatModelFn = async (input) => {
  const chat = input.createChatCompletion as SeatChatCompletionFn;
  try {
    const out = await chat({ model: MODEL, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: "Available tools: file_ops\nRespond as JSON." }] });
    return { output: {}, model: MODEL, tokens: out.usage?.total_tokens ?? 0, costCents: 18, fallback: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { output: { error: message }, model: MODEL, tokens: 0, costCents: 0, fallback: true, error: message };
  }
};

function seatInput(chat: SeatChatCompletionFn): SeatModelInput {
  return { subtask: { id: "s1", seat: "engineer" }, createChatCompletion: chat };
}

describe("[L1] the meter records every call a seat turn made", () => {
  let profileDir: string;
  const savedAlias = process.env[ALIAS_ENV];

  beforeEach(() => {
    process.env[ALIAS_ENV] = "ollama";
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-spend-reask-"));
    installSpendLedger(openSpendLedger({ profileDir }));
    openRunScope([], RUN, { companyId: "co", objective: "todo", surface: "run" });
  });

  afterEach(() => {
    closeRunScope([], RUN);
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
    if (savedAlias === undefined) delete process.env[ALIAS_ENV];
    else process.env[ALIAS_ENV] = savedAlias;
  });

  it("a turn the re-ask saved: both calls' tokens are on the seat's row", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const port = createSeatChatPort(scripted(["not json at all", '{"tool":"file_ops","args":{"path":"a"}}']));
    const result = await meter.seatModel(appExecutor)(seatInput(port));
    expect(result.error).toBeUndefined();
    closeRunScope([], RUN);
    expect(currentSpendLedger()?.rows()).toEqual([expect.objectContaining({ seat: "engineer", model: MODEL, inputTokens: 6_000, outputTokens: 80 })]);
  });

  it("a turn that still failed: the seat's error names it, and both calls are still on the ledger", async () => {
    const meter = createRunSpendMeter(() => RUN);
    const port = createSeatChatPort(scripted(["not json at all", "still not json"]));
    const result = await meter.seatModel(appExecutor)(seatInput(port));
    expect(result.error).toMatch(/seat turn unusable after one re-ask: unparseable/);
    closeRunScope([], RUN);
    expect(currentSpendLedger()?.rows()).toEqual([expect.objectContaining({ seat: "engineer", model: MODEL, inputTokens: 6_000, outputTokens: 80 })]);
  });
});
