/**
 * [L0-2] RED for audit G2 + G16 (item 2): a local model gets a time-to-first-token budget sized for
 * prefill (`models.local.ttft_seconds`, default 300 s) and an idle budget between tokens after that
 * (`models.local.idle_seconds`, default 120 s); a hosted provider keeps today's 60 s budget for its
 * response headers. On this machine a 27B model's planner call died at the app client's 60 s after
 * 187 s of retries (audit section 3).
 *
 * The clock is vitest's fake one, so the real figures (90 s, 300 s) are asserted without waiting.
 * Responses come from the gateway's `fetchImpl` seam; every base URL is `127.0.0.1:9`, where nothing
 * listens, so a call that bypassed the seam would fail here rather than leave the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createModelGateway } from "./index.js";
import { clearLocalProbeCache } from "./local-probe.js";
import { ALIAS_ENV, applyProviderAliasEnv } from "./providers.js";
import type { GatewayCompletion } from "./types.js";

const DEAD = "http://127.0.0.1:9/v1";
const ENV_KEYS = [
  ALIAS_ENV, "OLLAMA_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS",
  "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC", "WORKBENCH_EXECUTOR_MODEL",
  "WORKBENCH_PLANNER_MODEL", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY",
  "TRENT_LOCAL_TTFT_SECONDS", "TRENT_LOCAL_IDLE_SECONDS", "TRENT_LOCAL_MAX_IN_FLIGHT", "TRENT_REASONING_EFFORT",
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  clearLocalProbeCache();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const encoder = new TextEncoder();
const frame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const TOKEN = (content: string) => frame({ choices: [{ index: 0, delta: { content } }] });
const FINISH = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
const USAGE = frame({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 2 } });
const DONE = encoder.encode("data: [DONE]\n\n");

interface Script {
  /** When the response headers arrive; `undefined` = never. */
  readonly headersAt?: number;
  /** When the first token arrives, measured from the request. */
  readonly firstTokenAt?: number;
  /** After the first token: finish normally, or go silent forever. */
  readonly thenStall?: boolean;
}

/** A server on the fake clock. It honours the abort signal the way `fetch` does. */
function scriptedFetch(script: Script) {
  const requests: string[] = [];
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      requests.push(url);
      const signal = init?.signal ?? undefined;
      const abortError = (): Error => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      if (signal?.aborted) return reject(abortError());
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      if (script.headersAt === undefined) return;
      setTimeout(() => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(abortError()), { once: true });
            if (script.firstTokenAt === undefined) return;
            setTimeout(() => {
              if (signal?.aborted) return;
              controller.enqueue(TOKEN("rea"));
              if (script.thenStall) return;
              controller.enqueue(TOKEN("dy"));
              controller.enqueue(FINISH);
              controller.enqueue(USAGE);
              controller.enqueue(DONE);
              controller.close();
            }, Math.max(0, script.firstTokenAt - (script.headersAt ?? 0)));
          },
        });
        resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
      }, script.headersAt);
    });
  return { fetchImpl, requests };
}

type Outcome = { ok: true; value: GatewayCompletion } | { ok: false; error: Error };

async function run(script: Script, route: "ollama" | "openai", advanceMs: number) {
  const { fetchImpl, requests } = scriptedFetch(script);
  const usage: unknown[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let gatewayConfig: Parameters<typeof createModelGateway>[0] = { fetchImpl };
  if (route === "ollama") {
    process.env.OLLAMA_BASE_URL = DEAD;
    applyProviderAliasEnv("ollama", "qwen3.5:9b");
  } else {
    process.env.OPENAI_BASE_URL = DEAD;
    gatewayConfig = { ...gatewayConfig, apiKeys: { openai: "test-openai-key" }, preferredProvider: "openai", allowedProviders: ["openai"] };
  }
  const gateway = await createModelGateway({
    ...gatewayConfig,
    retry: { attempts: 3, random: () => 0, sleep: async () => undefined },
    retryLog: (event, fields) => logs.push({ event, fields }),
  });
  const stream = gateway.stream({ messages: [{ role: "user", content: "Say ready" }], ...(route === "openai" ? { model: "gpt-4.1-mini" } : {}) });
  const settled: Promise<Outcome> = (async () => {
    let text = "";
    try {
      for await (const event of stream) {
        if (event.type === "token") text += event.content;
        if (event.type === "usage") usage.push(event);
      }
      return { ok: true, value: { text } as GatewayCompletion };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  })();
  await vi.advanceTimersByTimeAsync(advanceMs);
  return { outcome: await settled, requests, usage, logs };
}

describe("local provider budgets (models.local.*)", () => {
  it("a local server that answers after 90 s completes, with ONE attempt and one ledger row", async () => {
    const { outcome, requests, usage } = await run({ headersAt: 90_000, firstTokenAt: 90_000 }, "ollama", 95_000);
    expect(outcome).toMatchObject({ ok: true, value: { text: "ready" } });
    expect(requests).toEqual([`${DEAD}/chat/completions`]);
    expect(usage).toHaveLength(1);
  });

  it("headers at once but the first token after 200 s is still inside the budget (prefill, not headers)", async () => {
    const { outcome } = await run({ headersAt: 1_000, firstTokenAt: 200_000 }, "ollama", 205_000);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("a local server that never answers fails naming the budget and the setting, after one retry", async () => {
    const { outcome, requests } = await run({}, "ollama", 700_000);
    expect(outcome.ok).toBe(false);
    const message = outcome.ok ? "" : outcome.error.message;
    expect(message).toMatch(/300 s/);
    expect(message).toMatch(/models\.local\.ttft_seconds/);
    expect(requests).toHaveLength(2);
  });

  it("the budget is the configured one", async () => {
    process.env.TRENT_LOCAL_TTFT_SECONDS = "100";
    const late = await run({ headersAt: 120_000, firstTokenAt: 120_000 }, "ollama", 250_000);
    expect(late.outcome.ok).toBe(false);
    expect(late.outcome.ok ? "" : late.outcome.error.message).toMatch(/100 s.*models\.local\.ttft_seconds/);
  });

  it("silence after the first token ends at the idle budget, and is not retried (a token was delivered)", async () => {
    const { outcome, requests } = await run({ headersAt: 5_000, firstTokenAt: 10_000, thenStall: true }, "ollama", 140_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error.message).toMatch(/120 s.*models\.local\.idle_seconds/);
    expect(requests).toHaveLength(1);
  });
});

describe("hosted providers keep today's budget", () => {
  it("openai: headers after 90 s fail at the 60 s headers budget, retried once", async () => {
    const { outcome, requests } = await run({ headersAt: 90_000, firstTokenAt: 90_000 }, "openai", 130_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error.message).toMatch(/openai request sent no response headers within 60000ms/);
    expect(requests).toHaveLength(2);
  });
});
