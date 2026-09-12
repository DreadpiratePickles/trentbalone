import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SteelBrowserClient,
  buildSteelToolScopes,
  getSteelConfig,
} from "@/lib/steel-browser";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Steel browser client", () => {
  it("uses Steel Cloud defaults and reports missing credentials safely", async () => {
    const client = new SteelBrowserClient();

    expect(getSteelConfig()).toEqual({
      baseUrl: "https://api.steel.dev/v1",
      apiKey: undefined,
      defaultUserId: "trent",
    });
    await expect(client.healthCheck()).resolves.toBe("needs_credentials");
  });

  it("captures screenshots through the Steel one-shot endpoint", async () => {
    vi.stubEnv("STEEL_API_KEY", "secret_steel_key");
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "https://files.steel.dev/v1/static/screenshot.png" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => png.buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SteelBrowserClient();
    const result = await client.screenshot({ url: "https://example.com", fullPage: true, delayMs: 1200 });

    expect(result).toEqual(Buffer.from(png));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.steel.dev/v1/screenshot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "steel-api-key": "secret_steel_key",
      },
      body: JSON.stringify({ url: "https://example.com", fullPage: true, delay: 1200 }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://files.steel.dev/v1/static/screenshot.png");
  });

  it("redacts Steel API keys from failed requests", async () => {
    vi.stubEnv("STEEL_API_KEY", "secret_steel_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad secret_steel_key",
    }));

    const client = new SteelBrowserClient();

    await expect(client.scrape({ url: "https://example.com" })).rejects.toThrow("Steel request failed: 401: bad [redacted]");
    await expect(client.scrape({ url: "https://example.com" })).rejects.not.toThrow("secret_steel_key");
  });

  it("declares Steel browser scopes used by agents and app-solo", () => {
    expect(buildSteelToolScopes()).toEqual([
      "steel:scrape",
      "steel:screenshot",
      "steel:pdf",
      "steel:sessions",
    ]);
  });
});
