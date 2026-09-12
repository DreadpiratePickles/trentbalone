import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CamofoxBrowserClient,
  buildCamofoxToolScopes,
  getCamofoxConfig,
} from "@/lib/camofox-browser";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Camofox browser client", () => {
  it("uses localhost defaults and reports health from the Camofox server", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CamofoxBrowserClient();

    await expect(client.healthCheck()).resolves.toBe("connected");
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9377/health", {
      headers: {},
      method: "GET",
    });
  });

  it("adds bearer authorization when CAMOFOX_ACCESS_KEY is configured", async () => {
    vi.stubEnv("CAMOFOX_ACCESS_KEY", "secret_camofox_key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "tab_1", url: "https://example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CamofoxBrowserClient();
    await client.createTab({ userId: "agent_1", sessionKey: "run_1", url: "https://example.com" });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9377/tabs", {
      body: JSON.stringify({ userId: "agent_1", sessionKey: "run_1", url: "https://example.com" }),
      headers: {
        Authorization: "Bearer secret_camofox_key",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  });

  it("also accepts the repo-documented CAMOFOX_API_KEY for bearer authorization", async () => {
    vi.stubEnv("CAMOFOX_API_KEY", "secret_camofox_api_key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tabId: "tab_1", url: "https://example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CamofoxBrowserClient();
    await client.createTab({ userId: "agent_1", sessionKey: "run_1", url: "https://example.com" });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:9377/tabs", {
      body: JSON.stringify({ userId: "agent_1", sessionKey: "run_1", url: "https://example.com" }),
      headers: {
        Authorization: "Bearer secret_camofox_api_key",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
  });

  it("normalizes Camofox create-tab responses that use tabId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tabId: "tab_1", url: "about:blank" }),
    }));

    const client = new CamofoxBrowserClient();
    await expect(client.createTab({ userId: "agent_1", sessionKey: "run_1" })).resolves.toEqual({
      id: "tab_1",
      url: "about:blank",
    });
  });

  it("navigates, snapshots, clicks, types, screenshots, and closes tabs through Camofox endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "tab_1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://example.com/search" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ snapshot: "[link e1] Result", screenshot: "base64png" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Buffer.from("png").buffer })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ closed: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CamofoxBrowserClient();
    await client.createTab({ userId: "agent_1", sessionKey: "run_1" });
    await client.navigate("tab_1", { userId: "agent_1", url: "https://example.com/search" });
    await client.snapshot("tab_1", { userId: "agent_1", includeScreenshot: true });
    await client.click("tab_1", { userId: "agent_1", ref: "e1" });
    await client.type("tab_1", { userId: "agent_1", ref: "e2", text: "hello", pressEnter: true });
    await client.screenshot("tab_1", { userId: "agent_1" });
    await client.closeTab("tab_1", { userId: "agent_1" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:9377/tabs",
      "http://localhost:9377/tabs/tab_1/navigate",
      "http://localhost:9377/tabs/tab_1/snapshot?userId=agent_1&includeScreenshot=true",
      "http://localhost:9377/tabs/tab_1/click",
      "http://localhost:9377/tabs/tab_1/type",
      "http://localhost:9377/tabs/tab_1/screenshot?userId=agent_1",
      "http://localhost:9377/tabs/tab_1?userId=agent_1",
    ]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ userId: "agent_1", url: "https://example.com/search" }));
    expect(fetchMock.mock.calls[3][1]?.body).toBe(JSON.stringify({ userId: "agent_1", ref: "e1" }));
  });

  it("maps failed Camofox responses to useful errors without leaking access keys", async () => {
    vi.stubEnv("CAMOFOX_ACCESS_KEY", "secret_camofox_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server mentioned secret_camofox_key while failing",
    }));

    const client = new CamofoxBrowserClient();

    await expect(client.healthCheck()).resolves.toBe("needs_credentials");
    await expect(client.createTab({ userId: "agent_1" })).rejects.toThrow("Camofox request failed: 500");
    await expect(client.createTab({ userId: "agent_1" })).rejects.not.toThrow("secret_camofox_key");
  });

  it("declares all browser scopes needed by agents and command surfaces", () => {
    expect(getCamofoxConfig()).toEqual({
      baseUrl: "http://localhost:9377",
      accessKey: undefined,
      defaultUserId: "trent",
    });
    expect(buildCamofoxToolScopes()).toEqual([
      "camofox:tab",
      "camofox:navigate",
      "camofox:snapshot",
      "camofox:click",
      "camofox:type",
      "camofox:scroll",
      "camofox:screenshot",
      "camofox:close",
    ]);
  });
});
