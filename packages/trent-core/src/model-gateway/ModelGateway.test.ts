/**
 * Offline unit tests for the model gateway wrapper. No network, no real keys.
 * Every provider stream is injected through `streamProvider`.
 */
import { describe, expect, it, vi } from "vitest";

import { createModelGateway } from "./index.js";
import type { GatewayStreamEvent, ProviderStreamFn } from "./types.js";

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
