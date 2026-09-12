import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckRateLimit, mockWithRlsContext } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

import { registerProxyApiKey, resetProxyApiKeysForTest } from "@/lib/ai-proxy/api-keys";
import { store } from "@/lib/store";
import { POST } from "./route";

describe("/v1/chat/completions", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 401 for missing or invalid bearer keys", async () => {
    const res = await POST(new Request("http://x/v1/chat/completions", { method: "POST", body: "{}" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_api_key" });
  });

  it("uses key rate limiting, RLS, usage recording, and returns OpenAI-compatible output", async () => {
    await store.getCompany("company_trent_demo");
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-chat",
      name: "Chat",
      scopes: ["chat"],
      tier: "api_only",
    });

    const res = await POST(new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer sk-trent-chat" },
      body: JSON.stringify({
        model: "trent-sonnet",
        messages: [{ role: "user", content: "do not leak this raw prompt" }],
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.stringMatching(/^proxy_key_/), "company_trent_demo");
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "trent-sonnet",
      choices: [{ index: 0 }],
    });
    expect(JSON.stringify(body)).not.toContain("do not leak this raw prompt");
  });
});
