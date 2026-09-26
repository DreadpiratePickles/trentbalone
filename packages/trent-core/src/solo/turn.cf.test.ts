/**
 * [CF] The three council follow-ups that live in the solo turn (`turn.ts`), through the real runner:
 *   - C14.1: on anthropic the request offers native tools (`native-tools.ts`), so Claude answers with `tool_use`
 *     and little or no text; the completion's native calls are handed to the parser, so the call runs instead of
 *     the reply reading as empty;
 *   - C14.1: a call's prompt-cache WRITES reach the meter, so the run's ledger row carries them, priced at 1.25x;
 *   - C11 open item 3: a successful call repeated with the same result stops the run with a verdict naming the
 *     loop (`repeat-stop.ts`), before the tool-call cap.
 * The model is a script: every completion a test sees is one it wrote. The ledger is a temp file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import { verdictOf } from "../orchestrator/verdict.js";
import { FIXED_NOW, collect, completion, fakeAdapter, fakeMemory, fakeMeter, kinds, memorySession, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { createRunLedgerMeter } from "./meter.js";
import { SOLO_SUCCESS_REPEATS } from "./repeat-stop.js";
import { createSoloRunner } from "./runner.js";
import type { SoloGateway, SoloMeter } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  installSpendLedger(undefined);
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A gateway that answers each request with the next completion, and records the requests. */
function answering(replies: readonly GatewayCompletion[]): SoloGateway & { readonly requests: GatewayStreamRequest[] } {
  const requests: GatewayStreamRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const reply = replies[requests.length - 1];
      if (reply === undefined) throw new Error(`the test script has no reply for call ${String(requests.length)}`);
      return reply;
    },
  };
}

function runner(gateway: SoloGateway, adapters: ReturnType<typeof fakeAdapter>[], meter: SoloMeter = fakeMeter(), provider?: string) {
  return createSoloRunner({ gateway, tools: { adapters }, session: memorySession(), memory: fakeMemory().memory, meter, now: FIXED_NOW, newId: sequentialIds(), ...(provider === undefined ? {} : { provider }) });
}

describe("[CF] C14.1: a native tool_use on anthropic runs as the call it names", () => {
  it("a reply that is only a tool_use (no text) runs read_file once, with no repair, and the run answers", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "README: hello" }) });
    const gateway = answering([
      { ...completion(""), provider: "anthropic", model: "claude-sonnet-4-6", toolCalls: [{ id: "toolu_01", name: "read_file", arguments: { path: "README.md" } }] },
      { ...completion("The README says hello."), provider: "anthropic", model: "claude-sonnet-4-6" },
    ]);

    const events = await collect(runner(gateway, [files], fakeMeter(), "anthropic").run({ objective: "What does the README say?" }));

    expect(gateway.requests[0]?.tools?.map((tool) => tool.name)).toContain("read_file");
    expect(files.calls.map((call) => call.action)).toEqual(['read_file {"path":"README.md"}']);
    expect(events.filter((event) => event.kind === "step_note").map((event) => event.detail)).not.toContainEqual(expect.stringMatching(/could not be parsed|empty/));
    expect(kinds(events).at(-1)).toBe("run_done");
    expect(events.at(-1)?.run).toMatchObject({ status: "completed", summary: "The README says hello." });
  });
});

describe("[CF] C14.1: cache writes reach the run's ledger row", () => {
  it("1M prompt tokens written to the cache on claude-sonnet-4-6: the row carries them and costs 375 cents, not 300", async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cf-turn-ledger-"));
    temps.push(profileDir);
    installSpendLedger(openSpendLedger({ profileDir }));
    const written = { ...completion("Done."), provider: "anthropic" as const, model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 0, cacheWriteInputTokens: 1_000_000, costCents: 375 };

    await collect(runner(answering([written]), [], createRunLedgerMeter({ surface: "run", companyId: "co" })).run({ objective: "Say done." }));

    expect(currentSpendLedger()?.rows()).toEqual([expect.objectContaining({ seat: "trent", model: "claude-sonnet-4-6", cents: 375, inputTokens: 1_000_000, cacheWriteInputTokens: 1_000_000 })]);
  });
});

describe("[CF] C11 open item 3: a repeated successful call stops the run", () => {
  it(`the ${String(SOLO_SUCCESS_REPEATS)}th identical read with the same result ends the run with a verdict naming the loop; no further call runs`, async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "brief: ship on Friday" }) });
    const read = toolCall('{"name": "read_file", "arguments": {"path": "notes/brief.txt"}}');
    const script = [...Array.from({ length: SOLO_SUCCESS_REPEATS + 1 }, () => completion(read)), completion("Friday.")];

    const events = await collect(runner(answering(script), [files]).run({ objective: "When do we ship?" }));

    expect(files.calls).toHaveLength(SOLO_SUCCESS_REPEATS);
    expect(kinds(events).at(-1)).toBe("run_failed");
    const verdict = verdictOf(events.at(-1));
    expect(verdict?.summary).toMatch(/loop/);
    expect(verdict?.summary).toContain("read_file");
    expect(verdict?.summary).not.toMatch(/cap of/);
  });
});
