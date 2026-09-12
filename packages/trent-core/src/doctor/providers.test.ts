import { describe, it, expect, vi } from "vitest";
import {
  PROVIDER_CREDENTIALS,
  credentialForProvider,
  ANTHROPIC_MIN_KEY_LENGTH,
} from "./providers.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "./probe.js";

/** The exact placeholder shape found in ~/.trent/.env on this machine: 16 characters. */
const PLACEHOLDER_ANTHROPIC = "sk-ant-placeh0ld";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provider credential shapes", () => {
  it("rejects a 16-character sk-ant- placeholder and names the length", () => {
    const anthropic = credentialForProvider("anthropic");
    expect(anthropic).toBeDefined();
    const verdict = anthropic!.validateShape(PLACEHOLDER_ANTHROPIC);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("16");
    expect(verdict.reason).toContain(String(ANTHROPIC_MIN_KEY_LENGTH));
    expect(verdict.reason).not.toContain(PLACEHOLDER_ANTHROPIC);
  });

  it("accepts a plausibly sized anthropic key", () => {
    const key = "sk-ant-api03-" + "a".repeat(95);
    expect(credentialForProvider("anthropic")!.validateShape(key).valid).toBe(true);
  });

  it("requires the provider prefix", () => {
    expect(credentialForProvider("anthropic")!.validateShape("x".repeat(120)).valid).toBe(false);
    expect(credentialForProvider("openai")!.validateShape("nope-" + "x".repeat(60)).valid).toBe(false);
    expect(credentialForProvider("google")!.validateShape("BIza" + "x".repeat(35)).valid).toBe(false);
  });

  it("accepts a well-formed openai and google key", () => {
    expect(credentialForProvider("openai")!.validateShape("sk-" + "a".repeat(60)).valid).toBe(true);
    expect(credentialForProvider("google")!.validateShape("AIza" + "a".repeat(35)).valid).toBe(true);
  });

  it("covers every provider the config schema allows to need a key", () => {
    for (const id of ["openai", "anthropic", "google", "mistral", "openrouter", "deepseek", "groq"]) {
      expect(PROVIDER_CREDENTIALS[id], id).toBeDefined();
    }
  });
});

describe("provider probes", () => {
  it("maps 200 to ok and 401 to unauthorized", async () => {
    const google = credentialForProvider("google")!;
    const ok = await google.probe("AIza" + "a".repeat(35), undefined, {
      fetchImpl: async () => jsonResponse(200, { models: [] }),
    });
    expect(ok).toBe("ok");

    const bad = await google.probe("AIza" + "a".repeat(35), undefined, {
      fetchImpl: async () => jsonResponse(401, { error: "invalid" }),
    });
    expect(bad).toBe("unauthorized");
  });

  it("maps an unreachable host to unreachable, never unauthorized", async () => {
    const anthropic = credentialForProvider("anthropic")!;
    const outcome = await anthropic.probe("sk-ant-" + "a".repeat(100), undefined, {
      fetchImpl: async () => {
        throw new TypeError("fetch failed: ENOTFOUND");
      },
    });
    expect(outcome).toBe("unreachable");
  });

  it("completes within the timeout when the fetch never resolves", async () => {
    const openai = credentialForProvider("openai")!;
    const started = Date.now();
    const outcome = await openai.probe("sk-" + "a".repeat(60), undefined, {
      fetchImpl: () => new Promise<Response>(() => {}),
      timeoutMs: 60,
    });
    const elapsed = Date.now() - started;
    expect(outcome).toBe("unreachable");
    expect(elapsed).toBeLessThan(2000);
  });

  it("passes an AbortSignal to fetch and defaults the timeout to 5s", async () => {
    const openai = credentialForProvider("openai")!;
    const seen = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200);
    });
    await openai.probe("sk-" + "a".repeat(60), undefined, { fetchImpl: seen });
    expect(seen).toHaveBeenCalledOnce();
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5000);
  });

  it("never places the key in the request URL", async () => {
    for (const id of ["openai", "anthropic", "google"]) {
      const cred = credentialForProvider(id)!;
      const key = id === "google" ? "AIza" + "k".repeat(35) : "sk-ant-" + "k".repeat(100);
      let seenUrl = "";
      await cred.probe(key, undefined, {
        fetchImpl: async (url: string) => {
          seenUrl = url;
          return jsonResponse(200);
        },
      });
      expect(seenUrl, id).not.toContain(key);
      expect(seenUrl, id).toMatch(/^https:\/\//);
    }
  });
});
