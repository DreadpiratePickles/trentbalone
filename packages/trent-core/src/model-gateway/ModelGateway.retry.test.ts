/**
 * RED for A.4 / D-6: "one attempt per provider, no backoff, no 429 handling, no Retry-After; a
 * rate limit is an immediate run failure."
 *
 * Offline: every provider stream is injected through `streamProvider`, and the retry sleep is
 * injected too, so the delays are ASSERTED rather than waited for.
 */
import { describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import { ProviderHttpError } from "./retry.js";
import type { GatewayStreamEvent, ModelProvider, ProviderStreamFn } from "./types.js";

type Attempt = "429" | "429-date" | "500" | "401" | "reset" | "ok" | "ok-then-fail";

const KEYS = { google: "test-google-key", anthropic: "test-anthropic-key" } as const;

/** A scripted provider: one entry per attempt, per provider. Records what was attempted. */
function scripted(script: Partial<Record<ModelProvider, Attempt[]>>): {
  streamProvider: ProviderStreamFn;
  attempts: ModelProvider[];
} {
  const attempts: ModelProvider[] = [];
  const cursor = new Map<ModelProvider, number>();
  const streamProvider: ProviderStreamFn = async function* (provider) {
    attempts.push(provider);
    const index = cursor.get(provider) ?? 0;
    cursor.set(provider, index + 1);
    const step = script[provider]?.[index] ?? "ok";
    switch (step) {
      case "429":
        throw new ProviderHttpError({ provider, status: 429, statusText: "Too Many Requests", headers: { "retry-after": "2" } });
      case "429-date":
        throw new ProviderHttpError({
          provider,
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": new Date(Date.now() + 3_000).toUTCString() },
        });
      case "500":
        throw new ProviderHttpError({ provider, status: 500, statusText: "Internal Server Error" });
      case "401":
        throw new ProviderHttpError({ provider, status: 401, statusText: "Unauthorized" });
      case "reset":
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      case "ok-then-fail":
        yield { type: "token", content: "half " };
        throw new ProviderHttpError({ provider, status: 500, statusText: "died mid-stream" });
      default:
        yield { type: "token", content: `answer-from-${provider}` };
        yield { type: "usage", inputTokens: 10, outputTokens: 5 };
        yield { type: "finish", reason: "stop" };
    }
  };
  return { streamProvider, attempts };
}

function gatewayWith(
  script: Partial<Record<ModelProvider, Attempt[]>>,
  opts: { providers?: ModelProvider[]; attemptsAllowed?: number } = {},
) {
  const { streamProvider, attempts } = scripted(script);
  const slept: number[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const chain = opts.providers ?? (["google"] as ModelProvider[]);
  const gateway = createModelGateway({
    apiKeys: Object.fromEntries(chain.map((p) => [p, KEYS[p as keyof typeof KEYS] ?? `test-${p}-key`])),
    preferredProvider: chain[0],
    allowedProviders: chain,
    models: { executor: "gemini-3.5-flash-lite" },
    streamProvider,
    retry: {
      attempts: opts.attemptsAllowed ?? 3,
      // random() === 1 pins full jitter to its ceiling so the backoff is assertable.
      random: () => 1,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
    retryLog: (event, fields) => logs.push({ event, fields }),
  });
  return { gateway, attempts, slept, logs };
}

async function drain(stream: AsyncGenerator<GatewayStreamEvent>): Promise<GatewayStreamEvent[]> {
  const events: GatewayStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const ASK = [{ role: "user" as const, content: "hi" }];

describe("model gateway retry — transient failures", () => {
  it("retries a 429 after the server's Retry-After and streams the second attempt", async () => {
    const { gateway, attempts, slept } = gatewayWith({ google: ["429", "ok"] });
    const events = await drain((await gateway).stream({ messages: ASK }));

    expect(attempts).toEqual(["google", "google"]);
    expect(slept).toEqual([2_000]); // the header, not the backoff curve
    expect(events.filter((e) => e.type === "token").map((e) => (e.type === "token" ? e.content : ""))).toEqual([
      "answer-from-google",
    ]);
    expect(events.find((e) => e.type === "finish")).toMatchObject({ reason: "stop" });
  });

  it("honours an HTTP-date Retry-After too", async () => {
    const { gateway, slept } = gatewayWith({ google: ["429-date", "ok"] });
    await drain((await gateway).stream({ messages: ASK }));
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(2_000);
    expect(slept[0]).toBeLessThanOrEqual(3_000);
  });

  it("retries a 500 on the exponential curve when no Retry-After is offered", async () => {
    const { gateway, attempts, slept } = gatewayWith({ google: ["500", "ok"] });
    const events = await drain((await gateway).stream({ messages: ASK }));
    expect(attempts).toEqual(["google", "google"]);
    expect(slept).toEqual([500]); // base * 2^0
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });

  it("retries a dropped socket", async () => {
    const { gateway, attempts, slept } = gatewayWith({ google: ["reset", "ok"] });
    await drain((await gateway).stream({ messages: ASK }));
    expect(attempts).toEqual(["google", "google"]);
    expect(slept).toEqual([500]);
  });
});

describe("model gateway retry — failures that must NOT be retried", () => {
  it("never retries a 401 and never silently degrades: one attempt, then the error", async () => {
    const { gateway, attempts, slept } = gatewayWith({ google: ["401", "ok"] });
    await expect(drain((await gateway).stream({ messages: ASK }))).rejects.toThrow(/401/);
    expect(attempts).toEqual(["google"]);
    expect(slept).toEqual([]);
  });

  it("does not retry and does not fall back once a token has reached the caller", async () => {
    const { gateway, attempts, slept } = gatewayWith(
      { google: ["ok-then-fail", "ok"], anthropic: ["ok"] },
      { providers: ["google", "anthropic"] },
    );
    const events: GatewayStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of (await gateway).stream({ messages: ASK })) events.push(event);
      })(),
    ).rejects.toThrow(/died mid-stream/);
    expect(events.filter((e) => e.type === "token")).toHaveLength(1);
    expect(attempts).toEqual(["google"]);
    expect(slept).toEqual([]);
  });
});

describe("model gateway retry — exhaustion hands over to the fallback chain", () => {
  it("tries the provider three times, backing off, then the next provider answers", async () => {
    const { gateway, attempts, slept } = gatewayWith(
      { google: ["500", "500", "500"], anthropic: ["ok"] },
      { providers: ["google", "anthropic"] },
    );
    const events = await drain((await gateway).stream({ messages: ASK }));

    expect(attempts).toEqual(["google", "google", "google", "anthropic"]);
    expect(slept).toEqual([500, 1_000]); // two sleeps for three attempts
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toMatchObject({ type: "usage", provider: "anthropic" });
  });

  it("throws the last error when every provider in the chain is exhausted", async () => {
    const { gateway, attempts } = gatewayWith(
      { google: ["500", "500", "500"], anthropic: ["500", "500", "500"] },
      { providers: ["google", "anthropic"] },
    );
    await expect(drain((await gateway).stream({ messages: ASK }))).rejects.toThrow(/500/);
    expect(attempts).toEqual(["google", "google", "google", "anthropic", "anthropic", "anthropic"]);
  });

  it("respects a configured attempt budget of 1 — retries off means straight to the fallback", async () => {
    const { gateway, attempts, slept } = gatewayWith(
      { google: ["500"], anthropic: ["ok"] },
      { providers: ["google", "anthropic"], attemptsAllowed: 1 },
    );
    await drain((await gateway).stream({ messages: ASK }));
    expect(attempts).toEqual(["google", "anthropic"]);
    expect(slept).toEqual([]);
  });
});

describe("model gateway retry — cancellation (contract trap 5)", () => {
  /** A gateway whose retry uses the REAL clock, so the abort behaviour is the thing under test. */
  async function realClockGateway(streamProvider: ProviderStreamFn, baseMs: number) {
    return createModelGateway({
      apiKeys: { google: KEYS.google },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: "gemini-3.5-flash-lite" },
      streamProvider,
      retry: { attempts: 3, baseMs, capMs: 60_000, random: () => 1 },
      retryLog: () => undefined,
    });
  }

  it("an abort during the backoff ends the wait at once and starts no further attempt", async () => {
    const { streamProvider, attempts } = scripted({ google: ["500", "ok"] });
    const controller = new AbortController();
    // A 30 s backoff nobody would sit through: if the sleep were not abortable, this test hangs.
    const gateway = await realClockGateway(streamProvider, 30_000);

    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error("user pressed ctrl+c")), 25);
    const events = await drain(gateway.stream({ messages: ASK, signal: controller.signal }));
    clearTimeout(timer);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(attempts).toEqual(["google"]);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
    expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
  });

  it("forwards the run's signal to the provider, so an implementation that can cancel does", async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const streamProvider: ProviderStreamFn = async function* (_provider, _model, input) {
      seen = input.signal;
      // Behaves like undici: the in-flight request rejects when the signal fires.
      await new Promise<never>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      yield { type: "token", content: "never reached" };
    };
    const gateway = await realClockGateway(streamProvider, 1);

    const timer = setTimeout(() => controller.abort(new Error("user pressed ctrl+c")), 10);
    const events = await drain(gateway.stream({ messages: ASK, signal: controller.signal }));
    clearTimeout(timer);

    expect(seen).toBe(controller.signal);
    expect(events.filter((e) => e.type === "token")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
  });

  it("does not wait for a provider that ignores the signal", async () => {
    const streamProvider: ProviderStreamFn = async function* () {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      yield { type: "token", content: "far too late" };
    };
    const controller = new AbortController();
    const gateway = await realClockGateway(streamProvider, 1);

    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error("user pressed ctrl+c")), 20);
    const events = await drain(gateway.stream({ messages: ASK, signal: controller.signal }));
    clearTimeout(timer);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
  });
});

describe("model gateway retry — observability", () => {
  it("logs every retry with the provider, status, attempt and delay, and no credential", async () => {
    const { gateway, logs } = gatewayWith({ google: ["429", "500", "ok"] });
    await drain((await gateway).stream({ messages: ASK }));

    const retries = logs.filter((entry) => entry.event === "model_gateway.retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]?.fields).toMatchObject({
      provider: "google",
      status: 429,
      errorClass: "rate_limit",
      attempt: 1,
      delayMs: 2_000,
    });
    expect(retries[1]?.fields).toMatchObject({ status: 500, errorClass: "dependency", attempt: 2 });
    const serialised = JSON.stringify(logs);
    expect(serialised).not.toContain(KEYS.google);
    expect(serialised).not.toMatch(/api[_-]?key/i);
  });
});

// [P1-C] a pinned model never falls back silently
describe("model gateway — a pinned model never falls back silently (P1-C)", () => {
  function pinned(script: Partial<Record<ModelProvider, Attempt[]>>, opts: { fallbackOnPin?: boolean } = {}) {
    const { streamProvider } = scripted(script);
    const seen: Array<[ModelProvider, string]> = [];
    const recording: ProviderStreamFn = (provider, model, input) => {
      seen.push([provider, model]);
      return streamProvider(provider, model, input);
    };
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const gateway = createModelGateway({
      apiKeys: { google: KEYS.google, anthropic: KEYS.anthropic },
      preferredProvider: "google",
      allowedProviders: ["google", "anthropic"],
      models: { executor: "gemini-3.5-flash-lite" },
      streamProvider: recording,
      retry: { attempts: 3, random: () => 1, sleep: async () => undefined },
      retryLog: (event, fields) => logs.push({ event, fields }),
      ...(opts.fallbackOnPin === undefined ? {} : { fallbackOnPin: opts.fallbackOnPin }),
    });
    return { gateway, seen, logs };
  }

  async function settle(stream: AsyncGenerator<GatewayStreamEvent>): Promise<{ events: GatewayStreamEvent[]; failure: unknown }> {
    const events: GatewayStreamEvent[] = [];
    try {
      for await (const event of stream) events.push(event);
      return { events, failure: undefined };
    } catch (failure) {
      return { events, failure };
    }
  }

  it("an explicit model fails with the provider error and no fallback attempt is made", async () => {
    const { gateway, seen, logs } = pinned({ google: ["401"], anthropic: ["ok"] });
    const { events, failure } = await settle((await gateway).stream({ messages: ASK, model: "gemini-3.6-flash" }));

    expect(failure).toBeInstanceOf(ProviderHttpError);
    expect((failure as ProviderHttpError).status).toBe(401);
    expect(seen).toEqual([["google", "gemini-3.6-flash"]]);
    // Nothing answered, so there is no usage event and nothing for any surface to write to the ledger.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(0);
    const failed = logs.filter((entry) => entry.event === "model_gateway.provider_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.fields).toMatchObject({ provider: "google", model: "gemini-3.6-flash", pinned: true, willFallBack: false, errorClass: "auth" });
  });

  it("a transient failure on a pinned model is retried on that model only, then fails", async () => {
    const { gateway, seen } = pinned({ google: ["500", "500", "500"], anthropic: ["ok"] });
    const { failure } = await settle((await gateway).stream({ messages: ASK, model: "gemini-3.6-flash" }));
    expect((failure as ProviderHttpError).status).toBe(500);
    expect(seen).toEqual([
      ["google", "gemini-3.6-flash"],
      ["google", "gemini-3.6-flash"],
      ["google", "gemini-3.6-flash"],
    ]);
  });

  it("a default-resolved model still falls back", async () => {
    const { gateway, seen, logs } = pinned({ google: ["401"], anthropic: ["ok"] });
    const { events, failure } = await settle((await gateway).stream({ messages: ASK }));
    expect(failure).toBeUndefined();
    expect(seen.map(([provider]) => provider)).toEqual(["google", "anthropic"]);
    expect(seen[0]?.[1]).toBe("gemini-3.5-flash-lite");
    expect(events.find((e) => e.type === "usage")).toMatchObject({ provider: "anthropic" });
    expect(logs.find((entry) => entry.event === "model_gateway.provider_failed")?.fields).toMatchObject({ pinned: false, willFallBack: true });
  });

  it("fallback_on_pin true restores the chain", async () => {
    const { gateway, seen } = pinned({ google: ["401"], anthropic: ["ok"] }, { fallbackOnPin: true });
    const { events, failure } = await settle((await gateway).stream({ messages: ASK, model: "gemini-3.6-flash" }));
    expect(failure).toBeUndefined();
    expect(seen[0]).toEqual(["google", "gemini-3.6-flash"]);
    // The fallback provider answers with ITS model, never the pinned Gemini id.
    expect(seen[1]?.[0]).toBe("anthropic");
    expect(seen[1]?.[1]).not.toBe("gemini-3.6-flash");
    expect(events.find((e) => e.type === "usage")).toMatchObject({ provider: "anthropic" });
  });

  it("a gateway built with no arguments reads fallback_on_pin from the env bridge", async () => {
    process.env.TRENT_MODEL_FALLBACK_ON_PIN = "false";
    try {
      const held = pinned({ google: ["401"], anthropic: ["ok"] });
      expect((await settle((await held.gateway).stream({ messages: ASK, model: "gemini-3.6-flash" }))).failure).toBeInstanceOf(ProviderHttpError);
      expect(held.seen.map(([provider]) => provider)).toEqual(["google"]);

      process.env.TRENT_MODEL_FALLBACK_ON_PIN = "true";
      const { gateway, seen } = pinned({ google: ["401"], anthropic: ["ok"] });
      const { failure } = await settle((await gateway).stream({ messages: ASK, model: "gemini-3.6-flash" }));
      expect(failure).toBeUndefined();
      expect(seen.map(([provider]) => provider)).toEqual(["google", "anthropic"]);
    } finally {
      delete process.env.TRENT_MODEL_FALLBACK_ON_PIN;
    }
  });
});
