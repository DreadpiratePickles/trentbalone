/**
 * D19 (security council 2026-09-26): `media_image` reads a real provider key in the Trent host
 * process, so the one promise it can make is that the key never comes back out: not in a tool
 * record, not in an error, on success or on any failure a provider or the transport can produce.
 *
 * Each case plants a sentinel key and a provider (or transport) that echoes it, then asserts that
 * no 8-character window of the key appears in the record the seat reads or in the thrown error,
 * its `String()` form, its own properties or its cause chain. A window, not the whole key, because
 * the realistic leaks quote part of a value: `JSON.parse` quotes the first ten characters of a bad
 * body, undici quotes a bad header up to its line break, and the tool keeps a message's first line.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryGatewayStore } from "../../gateway/store/GatewayStore.js";
import { createBoundApprovalStore, installBoundApprovals } from "../../governance/bound-approvals.js";
import { installSpendLedger, openSpendLedger } from "../../governance/spend-ledger.js";
import type { FetchLike } from "../web/proxied-fetch.js";
import { generateImage, resolveImageRoute, type ImageRouteConfig } from "./image.js";
import { createMediaAdapter } from "./index.js";

const GEMINI_KEY = "AIza-D19-SENTINEL-gemini-4b2d9e";
const OPENAI_KEY = "sk-D19-SENTINEL-openai-7c1f0e";
const PROMPT = "A plain test card.";

/** Every 8-character window of every line of the key, so a quoted fragment is caught too. */
function fragments(key: string): string[] {
  const out: string[] = [];
  for (const line of key.split(/\s+/)) for (let i = 0; i + 8 <= line.length; i += 1) out.push(line.slice(i, i + 8));
  return out;
}

function leaked(text: string, key: string): string | undefined {
  return fragments(key).find((piece) => text.includes(piece));
}

/** The message, the string form, the own properties and the cause chain of a thrown value. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    parts.push(String(current));
    if (current instanceof Error) {
      parts.push(current.message, current.stack ?? "");
      try {
        parts.push(JSON.stringify(current, Object.getOwnPropertyNames(current)));
      } catch {
        /* circular: the string forms above still count */
      }
      current = (current as { cause?: unknown }).cause;
    } else current = undefined;
  }
  return parts.join("\n");
}

type Answer = { status: number; body: string; contentType?: string } | { throws: Error };

function fakeFetch(answer: (key: string) => Answer, key: string): FetchLike {
  return (async () => {
    const a = answer(key);
    if ("throws" in a) throw a.throws;
    return new Response(a.body, { status: a.status, headers: { "content-type": a.contentType ?? "application/json" } });
  }) as FetchLike;
}

const CASES: ReadonlyArray<{ name: string; answer: (key: string) => Answer }> = [
  { name: "401 whose JSON error quotes the key", answer: (key) => ({ status: 401, body: JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }) }) },
  { name: "500 whose plain-text body echoes the Authorization header", answer: (key) => ({ status: 500, body: `upstream failed; request had Authorization: Bearer ${key} x-goog-api-key: ${key}`, contentType: "text/plain" }) },
  { name: "200 with no image and a text part that echoes the key", answer: (key) => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: `cannot draw; your key ${key} is on the free tier` }] } }], data: [] }) }) },
  { name: "200 whose body is not JSON and starts with the key", answer: (key) => ({ status: 200, body: `${key} is not a valid key for this endpoint` }) },
  { name: "a transport error whose message carries the header", answer: (key) => ({ throws: new Error(`request failed: headers {"authorization":"Bearer ${key}","x-goog-api-key":"${key}"}`, { cause: new Error(`socket closed after sending ${key}`) }) }) },
];

const PROVIDERS = [
  { label: "gemini", keyEnv: "GEMINI_API_KEY", key: GEMINI_KEY, env: (key: string) => ({ PATH: "", GEMINI_API_KEY: key, GEMINI_BASE_URL: "http://127.0.0.1:9/v1beta" }), config: { image_provider: "google", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0 } },
  { label: "openai", keyEnv: "OPENAI_API_KEY", key: OPENAI_KEY, env: (key: string) => ({ PATH: "", OPENAI_API_KEY: key, OPENAI_BASE_URL: "http://127.0.0.1:9/v1" }), config: { image_provider: "openai", image_model: "fixture-image-model", image_price_cents: 5, image_auto_approve_under_cents: 0 } },
] as const;

describe("media_image never returns its provider key (D19)", () => {
  let root = "";
  let workspace = "";
  let profileDir = "";

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-media-key-leak-"));
    workspace = path.join(root, "repo");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    installBoundApprovals(createBoundApprovalStore({ store: new MemoryGatewayStore() }));
    installSpendLedger(openSpendLedger({ profileDir }));
  });

  afterEach(() => {
    installBoundApprovals(undefined);
    installSpendLedger(undefined);
  });

  function adapter(env: NodeJS.ProcessEnv, config: ImageRouteConfig, fetchImpl?: FetchLike) {
    return createMediaAdapter(
      { workspace, profileDir, backend: "local" },
      {
        env,
        ...(fetchImpl ? { fetchImpl } : {}),
        media: { backend: "host", hosted_transcription: false, whisper_model: "", ...config, image_auto_approve_under_cents: 1000 } as never,
      },
    );
  }

  for (const provider of PROVIDERS) {
    for (const c of CASES) {
      it(`${provider.label}: ${c.name} — the key is in neither the thrown error nor the tool record`, async () => {
        const env = provider.env(provider.key);
        const fetchImpl = fakeFetch(c.answer, provider.key);
        const route = resolveImageRoute(provider.config, env);
        const thrown = await generateImage(route, { prompt: PROMPT, aspect: "1:1" }, env, fetchImpl).then(() => undefined, (error: unknown) => error);
        expect(thrown, "the fake provider never returns an image, so the call must fail").toBeDefined();
        expect(leaked(errorText(thrown), provider.key)).toBeUndefined();

        const rec = await adapter(env, provider.config, fetchImpl).execute(`media_image ${JSON.stringify({ prompt: PROMPT })}`, {});
        expect(rec.status).toBe("failed");
        expect(leaked(JSON.stringify(rec), provider.key)).toBeUndefined();
      });
    }

    it(`${provider.label}: a key with a line break in it fails as configuration, naming the variable, and no line of it is echoed`, async () => {
      const key = `${provider.key}-first\n${provider.key}-second`;
      const env = provider.env(key);
      // No fetch seam: the platform fetch's own header validation is what used to quote the value.
      const rec = await adapter(env, provider.config).execute(`media_image ${JSON.stringify({ prompt: PROMPT })}`, {});
      expect(rec.status).toBe("failed");
      expect(rec.summary).toContain(provider.keyEnv);
      expect(leaked(JSON.stringify(rec), key)).toBeUndefined();
      const thrown = await generateImage(resolveImageRoute(provider.config, env), { prompt: PROMPT, aspect: "1:1" }, env).then(() => undefined, (error: unknown) => error);
      expect(leaked(errorText(thrown), key)).toBeUndefined();
    });
  }
});
