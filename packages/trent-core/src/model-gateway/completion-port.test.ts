import { describe, expect, it } from "vitest";

import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "./types.js";

/**
 * The `createCompletion` port: the shape `callJson` (apps/web/lib/ai-client.ts:293-305) expects,
 * served by the real model gateway so the planner and critic reach the CONFIGURED provider instead
 * of the OpenAI-only default path.
 */

function gatewayReturning(text: string, calls: GatewayStreamRequest[], providers: string[] = ["google"]): ModelGateway {
  const completion = (): GatewayCompletion => ({
    text,
    provider: "google",
    model: "gemini-3.5-flash-lite",
    modelTier: "opus",
    inputTokens: 40,
    outputTokens: 12,
    costCents: 1,
    estimated: true,
    finishReason: "stop",
  });
  return {
    complete: async (req) => {
      calls.push(req);
      return completion();
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({
      providers: providers as never,
      fallbackChain: ["google"],
      modelTier: "opus",
      explicitModel: "gemini-3.5-flash-lite",
      modelForProvider: () => "gemini-3.5-flash-lite",
    }),
    configuredProviders: () => providers as never,
    estimateCostCents: () => 0,
  };
}

const MESSAGES = [
  { role: "system" as const, content: "You are the planner. Return JSON." },
  { role: "user" as const, content: "Plan this." },
];

describe("createCompletionPort", () => {
  it("routes the call to the gateway as the planner role, ignoring the OpenAI model name callJson passes", async () => {
    const { createCompletionPort } = await import("./completion-port.js");
    const calls: GatewayStreamRequest[] = [];
    const port = createCompletionPort(gatewayReturning('{"ok":true}', calls));
    const result = await port("gpt-5.2", MESSAGES, 512);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBe("planner");
    expect(calls[0]!.maxTokens).toBe(512);
    expect(calls[0]!.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(result.content).toBe('{"ok":true}');
    expect(result.totalTokens).toBe(52);
  });

  it("asks for JSON explicitly and returns only the JSON object when the model adds prose or fences", async () => {
    const { createCompletionPort } = await import("./completion-port.js");
    const calls: GatewayStreamRequest[] = [];
    const port = createCompletionPort(gatewayReturning('Sure! Here it is:\n```json\n{"verdict":"pass","reason":"fine"}\n```\nHope that helps.', calls));
    const result = await port("gpt-5.2", MESSAGES, 256);
    expect(JSON.parse(result.content ?? "")).toEqual({ verdict: "pass", reason: "fine" });
    expect(calls[0]!.messages[0]!.content).toMatch(/JSON/);
  });

  it("returns the raw text untouched when no JSON object can be found, so callJson reports non-JSON", async () => {
    const { createCompletionPort } = await import("./completion-port.js");
    const port = createCompletionPort(gatewayReturning("I cannot do that.", []));
    const result = await port("gpt-5.2", MESSAGES, 256);
    expect(result.content).toBe("I cannot do that.");
  });

  it("throws a 'not configured' error when no provider has a key, so the pipeline's offline paths engage", async () => {
    const { createCompletionPort } = await import("./completion-port.js");
    const calls: GatewayStreamRequest[] = [];
    const port = createCompletionPort(gatewayReturning("{}", calls, []));
    await expect(port("gpt-5.2", MESSAGES, 256)).rejects.toThrow(/not configured/i);
    expect(calls).toHaveLength(0);
  });

  it("reports every call and its outcome to the observer, without the prompt contents", async () => {
    const { createCompletionPort } = await import("./completion-port.js");
    const seen: Array<{ ok: boolean; error?: string; offline: boolean }> = [];
    const okPort = createCompletionPort(gatewayReturning("{}", []), { onCall: (record) => seen.push(record) });
    await okPort("gpt-5.2", MESSAGES, 256);
    const offlinePort = createCompletionPort(gatewayReturning("{}", [], []), { onCall: (record) => seen.push(record) });
    await offlinePort("gpt-5.2", MESSAGES, 256).catch(() => undefined);
    expect(seen).toEqual([
      { ok: true, offline: false },
      { ok: false, error: expect.stringMatching(/not configured/i), offline: true },
    ]);
    expect(JSON.stringify(seen)).not.toContain("Plan this.");
  });
});
