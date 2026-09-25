/**
 * Offline unit tests for the model gateway wrapper. No network, no real keys.
 * Every provider stream is injected through `streamProvider`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import { closeRunScope, openRunScope, recordRunSpend } from "../orchestrator/run-hooks.js";
import { createModelGateway } from "./index.js";
import type { GatewayStreamEvent, ProviderStreamFn, ProviderStreamFrame } from "./types.js";

const FAKE_KEYS = {
  google: "test-google-key",
  anthropic: "test-anthropic-key",
} as const;

function fakeProvider(
  frames: Array<{ type: "token"; content: string } | { type: "usage"; inputTokens: number; outputTokens: number } | { type: "finish"; reason: string }>,
  opts?: { delayMs?: number; onReturn?: () => void },
): ProviderStreamFn {
  return async function* () {
    try {
      for (const frame of frames) {
        if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        yield frame;
      }
    } finally {
      opts?.onReturn?.();
    }
  };
}

describe("createModelGateway — route resolution", () => {
  it("only reports providers whose keys were seeded into process.env", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google", "anthropic"],
      models: { executor: "gemini-2.0-flash" },
    });

    expect(gateway.configuredProviders()).toContain("google");
    expect(gateway.configuredProviders()).not.toContain("mistral");

    const route = gateway.resolveRoute("executor");
    expect(route.providers).toEqual(["google"]);
    expect(route.fallbackChain[0]).toBe("google");
    expect(route.explicitModel).toBe("gemini-2.0-flash");
    expect(route.modelForProvider("google")).toBe("gemini-2.0-flash");
  });

  it("resolves a provider-appropriate model name when the explicit model belongs elsewhere", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google, anthropic: FAKE_KEYS.anthropic },
      preferredProvider: "anthropic",
      allowedProviders: ["anthropic", "google"],
      models: { executor: "claude-sonnet-4-6" },
    });

    const route = gateway.resolveRoute("executor");
    expect(route.modelForProvider("anthropic")).toBe("claude-sonnet-4-6");
    expect(route.modelForProvider("google")).toMatch(/gemini/i);
  });

  it("uses the planner model for the planner role", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      allowedProviders: ["google"],
      preferredProvider: "google",
      models: { executor: "gemini-2.0-flash", planner: "gemini-2.5-pro" },
    });
    expect(gateway.resolveRoute("planner").explicitModel).toBe("gemini-2.5-pro");
  });
});

describe("createModelGateway — cost estimation", () => {
  it("always returns non-negative integer cents", async () => {
    const gateway = await createModelGateway({ apiKeys: { google: FAKE_KEYS.google } });
    const samples = [
      { modelTier: "haiku" as const, inputTokens: 1, outputTokens: 1 },
      { modelTier: "sonnet" as const, inputTokens: 1234, outputTokens: 567 },
      { modelTier: "opus" as const, inputTokens: 99_999, outputTokens: 42 },
      { modelTier: "sonnet" as const, inputTokens: 0, outputTokens: 0 },
    ];
    for (const sample of samples) {
      const cents = gateway.estimateCostCents(sample);
      expect(Number.isInteger(cents)).toBe(true);
      expect(cents).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches estimateModelCostCents from lib/model-gateway (the single source of truth)", async () => {
    const gateway = await createModelGateway({ apiKeys: { google: FAKE_KEYS.google } });
    const upstream = await import("@/lib/model-gateway");
    const input = { modelTier: "sonnet" as const, inputTokens: 4000, outputTokens: 2000 };
    expect(gateway.estimateCostCents(input)).toBe(upstream.estimateModelCostCents(input));
  });
});

describe("createModelGateway — usage frames", () => {
  it("passes through a real usage frame and marks it estimated: false", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-2.0-flash" },
      streamProvider: fakeProvider([
        { type: "token", content: "PONG" },
        { type: "token", content: "-7423" },
        { type: "usage", inputTokens: 11, outputTokens: 7 },
        { type: "finish", reason: "stop" },
      ]),
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ type: "usage", inputTokens: 11, outputTokens: 7, estimated: false });
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  it("synthesizes an estimated usage frame when the provider emits none (trap 4)", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-2.0-flash" },
      streamProvider: fakeProvider([
        { type: "token", content: "PONG-7423 and then some more text to count" },
        { type: "finish", reason: "stop" },
      ]),
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) {
      events.push(event);
    }

    const usage = events.find((e) => e.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage event synthesized");
    expect(usage.estimated).toBe(true);
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(Number.isInteger(usage.costCents)).toBe(true);
    expect(usage.costCents).toBeGreaterThanOrEqual(0);
  });

  it("never emits the canned ai-proxy literal for a normal stream", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-2.0-flash" },
      streamProvider: fakeProvider([{ type: "token", content: "real tokens" }, { type: "finish", reason: "stop" }]),
    });
    const completion = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(completion.text).not.toMatch(/^Trent proxy response/);
  });
});

describe("createModelGateway — cancellation", () => {
  it("stops mid-stream on signal.aborted, closes the generator, and leaves the process alive", async () => {
    const controller = new AbortController();
    const onReturn = vi.fn();

    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-2.0-flash" },
      streamProvider: fakeProvider(
        Array.from({ length: 200 }, (_, i) => ({ type: "token" as const, content: `t${i}` })),
        { delayMs: 1, onReturn },
      ),
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({
      messages: [{ role: "user", content: "hi" }],
      // Abort with a *reason* — an abort carrying a reason does NOT produce error.name === "AbortError".
      signal: controller.signal,
    })) {
      events.push(event);
      if (events.filter((e) => e.type === "token").length === 3) {
        controller.abort(new Error("user pressed ctrl+c"));
      }
    }

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(tokens.length).toBeLessThan(200);

    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ type: "finish", reason: "aborted" });

    // The upstream generator's finally ran => reader closed.
    expect(onReturn).toHaveBeenCalled();

    // Process is alive and the gateway is reusable after an abort.
    expect(gateway.configuredProviders()).toContain("google");
  });

  it("throws nothing and yields no tokens when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const gateway = await createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-2.0-flash" },
      streamProvider: fakeProvider([{ type: "token", content: "should not appear" }]),
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    })) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === "token")).toHaveLength(0);
    expect(events.find((e) => e.type === "finish")).toMatchObject({ reason: "aborted" });
  });
});

// [P1-C] cached prompt tokens
describe("createModelGateway — cached prompt tokens (P1-C)", () => {
  const frames = (usage: Extract<ProviderStreamFrame, { type: "usage" }>): ProviderStreamFn =>
    async function* () {
      yield { type: "token", content: "ok" };
      yield usage;
      yield { type: "finish", reason: "stop" };
    };

  async function flashLite(streamProvider: ProviderStreamFn) {
    return createModelGateway({
      apiKeys: { google: FAKE_KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-3.5-flash-lite" },
      streamProvider,
    });
  }

  it("a usage frame with cached_tokens prices them at the cached ratio and the ledger row records them", async () => {
    const gateway = await flashLite(frames({ type: "usage", inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 }));
    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({ messages: [{ role: "user", content: "hi" }] })) events.push(event);
    const usage = events.find((e) => e.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage event");
    expect(usage.cachedInputTokens).toBe(800_000);
    expect(usage.costCents).toBe(9); // 200k at $0.30/1M + 800k at $0.03/1M, not 30 at full rate

    const completion = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(completion).toMatchObject({ inputTokens: 1_000_000, cachedInputTokens: 800_000, costCents: 9 });

    // The run meter every surface writes through: the charge reaches the day's ledger row intact.
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cached-ledger-"));
    const ledger = openSpendLedger({ profileDir });
    installSpendLedger(ledger);
    try {
      openRunScope([], "run_cached", { companyId: "co_1", objective: "cache", surface: "repl" });
      recordRunSpend("run_cached", {
        model: completion.model,
        provider: completion.provider,
        cents: completion.costCents,
        tokens: completion.inputTokens + completion.outputTokens,
        ...(completion.cachedInputTokens === undefined ? {} : { cachedInputTokens: completion.cachedInputTokens }),
      });
      closeRunScope([], "run_cached");
      expect(ledger.rows()).toEqual([
        expect.objectContaining({ run_id: "run_cached", model: "gemini-3.5-flash-lite", cents: 9, tokens: 1_000_000, cachedInputTokens: 800_000 }),
      ]);
    } finally {
      installSpendLedger(undefined);
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("no cached_tokens field means zero and full price", async () => {
    const gateway = await flashLite(frames({ type: "usage", inputTokens: 1_000_000, outputTokens: 0 }));
    const completion = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(completion.cachedInputTokens).toBe(0);
    expect(completion.costCents).toBe(30);
  });

  it("thinking tokens a provider reports are billed as output and named on the row", async () => {
    const gateway = await flashLite(frames({ type: "usage", inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 999_000 }));
    const completion = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(completion).toMatchObject({ outputTokens: 1_000_000, reasoningTokens: 999_000, costCents: 250 });
  });
});

// [P1-C] the default google path: include_usage, cached tokens off the wire, reasoning_effort
describe("createModelGateway — the default google path (P1-C)", () => {
  const WIRE_USAGE = { prompt_tokens: 5_000, completion_tokens: 4, total_tokens: 5_004, prompt_tokens_details: { cached_tokens: 4_096 } };

  function wire() {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const text = [
        { choices: [{ delta: { content: "done" }, index: 0, finish_reason: "stop" }] },
        { choices: [], usage: WIRE_USAGE },
      ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    return { fetchImpl, bodies };
  }

  const base = { apiKeys: { google: FAKE_KEYS.google }, preferredProvider: "google" as const, allowedProviders: ["google" as const], models: { executor: "gemini-3.5-flash-lite" } };

  it("the body carries reasoning_effort when configured and omits it otherwise", async () => {
    const configured = wire();
    const low = await createModelGateway({ ...base, reasoningEffort: "low", fetchImpl: configured.fetchImpl });
    await low.complete({ messages: [{ role: "user", content: "hi" }] });
    await low.complete({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "high" });
    expect(configured.bodies.map((body) => body.reasoning_effort)).toEqual(["low", "high"]);

    const plain = wire();
    const unset = await createModelGateway({ ...base, fetchImpl: plain.fetchImpl });
    await unset.complete({ messages: [{ role: "user", content: "hi" }] });
    expect("reasoning_effort" in plain.bodies[0]!).toBe(false);
  });

  it("reads the cached tokens off the wire and reports real usage, not the chars/4 estimate", async () => {
    const { fetchImpl, bodies } = wire();
    const gateway = await createModelGateway({ ...base, fetchImpl });
    const completion = await gateway.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(bodies[0]!.stream_options).toEqual({ include_usage: true });
    expect(completion).toMatchObject({ text: "done", estimated: false, inputTokens: 5_000, cachedInputTokens: 4_096, outputTokens: 4 });
  });
});
