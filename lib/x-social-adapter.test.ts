import { describe, expect, it, vi } from "vitest";
import { buildXTweetPayload, createXSocialAdapter } from "./x-social-adapter";

describe("X social adapter", () => {
  it("fails closed without a user access token instead of returning mocked publish success", async () => {
    const adapter = createXSocialAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("unavailable");

    const result = await adapter.execute("publish", { text: "Launch day" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("X_USER_ACCESS_TOKEN");
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("requires approval before posting and publishes through X API after approval", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({
      data: { id: "1870000000000000000", text: "Launch day" },
    }), { status: 201 });
    });
    const adapter = createXSocialAdapter({
      env: { X_USER_ACCESS_TOKEN: "xox_user_secret" },
      fetchImpl,
    });

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("publish")).toBe(true);
    await expect(adapter.execute("publish", { text: "Launch day" })).resolves.toMatchObject({
      status: "needs_approval",
    });

    const result = await adapter.execute("publish", { approvalId: "approval_1", text: "Launch day", madeWithAi: true });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.x.com/2/tweets", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer xox_user_secret" }),
    }));
    expect(JSON.parse(String(requestInit?.body))).toEqual({ text: "Launch day", made_with_ai: true });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1870000000000000000");
    expect(result.summary).not.toContain("xox_user_secret");
  });

  it("validates tweet text length before attempting the external call", async () => {
    const fetchImpl = vi.fn();
    const adapter = createXSocialAdapter({
      env: { X_USER_ACCESS_TOKEN: "xox_user_secret" },
      fetchImpl,
    });

    const result = await adapter.execute("publish", { approvalId: "approval_1", text: "x".repeat(281) });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("280");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildXTweetPayload", () => {
  it("keeps the create-post payload narrowly scoped", () => {
    expect(buildXTweetPayload({ text: "Hello", quoteTweetId: "1346889436626259968" })).toEqual({
      text: "Hello",
      quote_tweet_id: "1346889436626259968",
    });
  });
});
