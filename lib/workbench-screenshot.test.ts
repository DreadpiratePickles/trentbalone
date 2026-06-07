import { afterEach, describe, expect, it, vi } from "vitest";
import * as screenshot from "@/lib/workbench-screenshot";
import {
  VIEWPORTS,
  captureScreenshot,
  isPlaywrightAvailable,
  resetPlaywrightAvailabilityCacheForTests,
} from "@/lib/workbench-screenshot";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetPlaywrightAvailabilityCacheForTests();
});

describe("VIEWPORTS", () => {
  it("defines mobile, tablet, and desktop viewports", () => {
    expect(VIEWPORTS.mobile.width).toBe(375);
    expect(VIEWPORTS.tablet.width).toBe(768);
    expect(VIEWPORTS.desktop.width).toBe(1280);
  });

  it("marks mobile and tablet as isMobile", () => {
    expect(VIEWPORTS.mobile.isMobile).toBe(true);
    expect(VIEWPORTS.tablet.isMobile).toBe(true);
    expect(VIEWPORTS.desktop.isMobile).toBe(false);
  });
});

describe("captureScreenshot", () => {
  it("uses Steel screenshots when Workbench is configured for Steel and the URL is public", async () => {
    vi.stubEnv("WORKBENCH_BROWSER_PROVIDER", "steel");
    vi.stubEnv("STEEL_API_KEY", "secret_steel_key");
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://files.steel.dev/screenshot.png" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => png.buffer });
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureScreenshot("https://preview.example.test", {
      width: 1280,
      height: 800,
      storageKey: "workbench/test/steel.png",
      sessionId: "sess_steel",
    });

    expect(result.dataUri).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.steel.dev/v1/screenshot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "steel-api-key": "secret_steel_key",
      },
      body: JSON.stringify({ url: "https://preview.example.test", fullPage: false, delay: 1000 }),
    });
  });

  it("skips Steel for a localhost preview and prefers local Playwright", async () => {
    // Steel Cloud cannot reach a localhost sandbox, so attempting it is always a
    // wasted, guaranteed-to-fail call. For local previews go straight to local
    // Playwright (which can reach localhost) regardless of the provider setting.
    vi.stubEnv("WORKBENCH_BROWSER_PROVIDER", "steel");
    vi.stubEnv("STEEL_API_KEY", "secret_steel_key");
    const fetchMock = vi.fn().mockRejectedValue(new Error("network disabled in test"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureScreenshot("http://localhost:4100", {
      width: 1280,
      height: 800,
      storageKey: "workbench/test/steel-localhost.png",
      sessionId: "sess_steel_localhost",
    });

    const steelCalled = fetchMock.mock.calls.some(([u]) => String(u).includes("api.steel.dev"));
    expect(steelCalled).toBe(false);
    const decoded = Buffer.from(result.dataUri.split(",")[1], "base64").toString("utf8");
    expect(decoded).not.toContain("Steel skipped");
  });

  it("still uses Steel for a localhost preview when STEEL_ALLOW_LOCAL_URLS is set", async () => {
    vi.stubEnv("WORKBENCH_BROWSER_PROVIDER", "steel");
    vi.stubEnv("STEEL_API_KEY", "secret_steel_key");
    vi.stubEnv("STEEL_ALLOW_LOCAL_URLS", "true");
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://files.steel.dev/s.png" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => png.buffer });
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureScreenshot("http://localhost:4100", {
      width: 1280,
      height: 800,
      storageKey: "workbench/test/steel-localhost-allowed.png",
      sessionId: "sess_steel_localhost_allowed",
    });

    expect(result.dataUri).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.steel.dev/v1/screenshot", expect.anything());
  });

  it("uses the Camofox browser provider when Workbench is configured for Camofox", async () => {
    vi.stubEnv("WORKBENCH_BROWSER_PROVIDER", "camofox");
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "tab_1", url: "about:blank" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "http://localhost:4100" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => png.buffer })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await captureScreenshot("http://localhost:4100", {
      width: 1280,
      height: 800,
      storageKey: "workbench/test/camofox.png",
      sessionId: "sess_camofox",
    });

    expect(result.dataUri).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:9377/tabs",
      "http://localhost:9377/tabs/tab_1/navigate",
      "http://localhost:9377/tabs/tab_1/screenshot?userId=workbench_sess_camofox",
      "http://localhost:9377/tabs/tab_1?userId=workbench_sess_camofox",
    ]);
  });

  it("returns a valid dataUri (SVG placeholder when Playwright not installed)", async () => {
    const result = await captureScreenshot("http://localhost:3000", {
      width: 1280,
      height: 800,
      storageKey: "workbench/test/screenshot.png",
      sessionId: "sess_test123",
    });
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
    expect(result.storageKey).toBe("workbench/test/screenshot.png");
    expect(result.dataUri).toMatch(/^data:image\/(png|svg\+xml);base64,/);
  });

  it("respects custom viewport dimensions", async () => {
    const result = await captureScreenshot("http://localhost:3000", {
      width: 375,
      height: 812,
      storageKey: "workbench/test/mobile.png",
      sessionId: "sess_mobile",
    });
    expect(result.width).toBe(375);
    expect(result.height).toBe(812);
  });

  it("SVG placeholder mentions playwright install hint when not available", async () => {
    resetPlaywrightAvailabilityCacheForTests();
    const result = await captureScreenshot("http://example.com", {
      width: 800,
      height: 600,
      storageKey: "k",
      sessionId: "s",
      _availabilityCheck: async () => false,
    });
    const decoded = Buffer.from(result.dataUri.split(",")[1], "base64").toString("utf8");
    expect(decoded).toContain("Preview placeholder (browser screenshot unavailable)");
    expect(decoded).toMatch(
      /playwright install chromium|Playwright unavailable|No browser screenshot backend/,
    );
  });
});

describe("isPlaywrightAvailable", () => {
  it("returns a boolean", async () => {
    const result = await isPlaywrightAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("is idempotent (caches the result)", async () => {
    const first = await isPlaywrightAvailable();
    const second = await isPlaywrightAvailable();
    expect(first).toBe(second);
  });

  it("does NOT cache a transient failure — it re-probes and recovers", async () => {
    // A memory-constrained host can OOM-crash the first chromium launch. That
    // must not permanently disable screenshots for the rest of the process.
    resetPlaywrightAvailabilityCacheForTests();
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error("OOM: Target page, context or browser has been closed");
      return { close: async () => {} };
    };
    expect(await isPlaywrightAvailable(flaky)).toBe(false);
    expect(await isPlaywrightAvailable(flaky)).toBe(true);
    expect(calls).toBe(2);
  });

  it("caches a positive result (does not relaunch once available)", async () => {
    resetPlaywrightAvailabilityCacheForTests();
    let calls = 0;
    const ok = async () => {
      calls += 1;
      return { close: async () => {} };
    };
    await isPlaywrightAvailable(ok);
    await isPlaywrightAvailable(ok);
    expect(calls).toBe(1);
  });
});

export {};
