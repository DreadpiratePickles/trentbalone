/**
 * THE anti-pattern #1 test.
 *
 * Proves the gateway streams REAL tokens from a REAL provider (google/gemini),
 * and never the canned literal from apps/web/lib/ai-proxy/openai-compatible.ts:93.
 *
 * The key is read from gem.env (gitignored). Its value is never printed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createModelGateway } from "./index.js";
import type { GatewayStreamEvent } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();

/**
 * `gemini-2.0-flash` — the hard-coded google default at apps/web/lib/ai-client.ts:73 —
 * has been retired by Google and 404s. apps/web is read-only, so the wrapper passes an
 * explicit, currently-served model instead. Reported, not patched.
 */
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.6-flash";

const SENTINEL_PROMPT = "Reply with exactly: PONG-7423";

if (!GEMINI_API_KEY) {
  console.error(
    "[ModelGateway.live] SKIPPED: no GEMINI_API_KEY. Put it in <repo>/gem.env as GEMINI_API_KEY=... " +
      "or export it. This suite is the proof that the gateway is not canned; a skip is NOT a pass.",
  );
}

describe.skipIf(!GEMINI_API_KEY)("ModelGateway (live, google/gemini)", () => {
  it("streams real incremental tokens containing the sentinel, with real usage and integer cost", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });

    expect(gateway.configuredProviders()).toContain("google");

    const route = gateway.resolveRoute("executor");
    expect(route.providers).toEqual(["google"]);
    expect(route.modelForProvider("google")).toMatch(/gemini/i);

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({
      role: "executor",
      messages: [{ role: "user", content: SENTINEL_PROMPT }],
      maxTokens: 1024,
      temperature: 0,
    })) {
      events.push(event);
    }

    const tokenFrames = events.filter((e) => e.type === "token");
    const output = tokenFrames.map((e) => (e.type === "token" ? e.content : "")).join("");
    const usage = events.find((e) => e.type === "usage");

    // eslint-disable-next-line no-console
    console.log(
      `[ModelGateway.live] provider=google model=${route.modelForProvider("google")} ` +
        `tokenFrames=${tokenFrames.length} output=${JSON.stringify(output)} usage=${JSON.stringify(usage)}`,
    );

    // 1. real frames off the wire. Google returns a 9-character answer in exactly one
    //    SSE chunk for every currently-served gemini model, so the ">1 frame" proof of
    //    incremental streaming lives in the next test, which asks for a long answer.
    expect(tokenFrames.length).toBeGreaterThanOrEqual(1);
    // 2. the model actually answered
    expect(output).toContain("PONG-7423");
    // 3. never the canned ai-proxy literal
    expect(output).not.toMatch(/^Trent proxy response/);
    // 4. a real usage event
    expect(usage).toBeDefined();
    if (usage?.type !== "usage") throw new Error("unreachable");
    expect(usage.outputTokens).toBeGreaterThan(0);
    // 5. integer cents
    expect(Number.isInteger(usage.costCents)).toBe(true);
    expect(usage.costCents).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("streams MORE THAN ONE token frame for a long answer (real incremental streaming, not one blob)", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });

    const events: GatewayStreamEvent[] = [];
    for await (const event of gateway.stream({
      role: "executor",
      messages: [
        { role: "user", content: `${SENTINEL_PROMPT}, then count from 1 to 40, one number per line.` },
      ],
      maxTokens: 2048,
      temperature: 0,
    })) {
      events.push(event);
    }

    const tokenFrames = events.filter((e) => e.type === "token");
    const output = tokenFrames.map((e) => (e.type === "token" ? e.content : "")).join("");

    // eslint-disable-next-line no-console
    console.log(`[ModelGateway.live] incremental tokenFrames=${tokenFrames.length} chars=${output.length}`);

    expect(tokenFrames.length).toBeGreaterThan(1);
    expect(output).toContain("PONG-7423");
    expect(output).not.toMatch(/^Trent proxy response/);
  }, 90_000);

  it("complete() returns the same real text through the non-streaming helper", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });

    const completion = await gateway.complete({
      role: "executor",
      messages: [{ role: "user", content: SENTINEL_PROMPT }],
      maxTokens: 1024,
      temperature: 0,
    });

    // eslint-disable-next-line no-console
    console.log(`[ModelGateway.live] complete=${JSON.stringify(completion)}`);

    expect(completion.provider).toBe("google");
    expect(completion.text).toContain("PONG-7423");
    expect(completion.text).not.toMatch(/^Trent proxy response/);
    expect(Number.isInteger(completion.costCents)).toBe(true);
  }, 60_000);
});
