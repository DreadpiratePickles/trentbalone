import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));

import { registerProxyApiKey, resetProxyApiKeysForTest } from "@/lib/ai-proxy/api-keys";
import { POST } from "./route";

function authed(body: unknown) {
  return new Request("http://x/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer sk-trent-mcp-route" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/mcp", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("rejects missing auth before JSON-RPC handling", async () => {
    const res = await POST(new Request("http://x/api/mcp", { method: "POST", body: "{}" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key_or_missing_mcp_scope" });
  });

  it("rate-limits by key and company", async () => {
    const key = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-route",
      name: "MCP",
      scopes: ["mcp"],
      tier: "api_only",
    });
    mockCheckRateLimit.mockResolvedValueOnce({ ok: false, retryAfterSeconds: 12 });

    const res = await POST(authed({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(key.keyId, "company_trent_demo");
  });

  it("handles initialize and notifications", async () => {
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-route",
      name: "MCP",
      scopes: ["mcp"],
      tier: "api_only",
    });

    const init = await POST(authed({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    expect(init.status).toBe(200);
    await expect(init.json()).resolves.toMatchObject({ result: { serverInfo: { name: "trent-os" } } });

    const note = await POST(authed({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
  });

  it("returns parse errors for invalid JSON and rejects batches", async () => {
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-route",
      name: "MCP",
      scopes: ["mcp"],
      tier: "api_only",
    });

    const invalid = await POST(authed("{"));
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: -32700 } });

    const batch = await POST(authed([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });
});
