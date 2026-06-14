import { describe, expect, it, vi } from "vitest";
import { buildXTweetPayload, createXSocialAdapter } from "./x-social-adapter";

describe("X social adapter", () => {
  it("fails closed without a user access token instead of returning mocked publish success", async () => {
    const adapter = createXSocialAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

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

  it("validates the user token during health checks instead of trusting env presence", async () => {
    const acceptedFetch = vi.fn(async () => new Response(JSON.stringify({
      data: { id: "user_1", username: "trent" },
    }), { status: 200 }));
    const accepted = createXSocialAdapter({
      env: { X_USER_ACCESS_TOKEN: "xox_user_secret" },
      fetchImpl: acceptedFetch,
    });

    await expect(accepted.healthCheck()).resolves.toBe("connected");
    expect(acceptedFetch).toHaveBeenCalledWith("https://api.x.com/2/users/me", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer xox_user_secret" }),
    }));

    const rejectedFetch = vi.fn(async () => new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 }));
    const rejected = createXSocialAdapter({
      env: { X_USER_ACCESS_TOKEN: "expired_secret" },
      fetchImpl: rejectedFetch,
    });

    await expect(rejected.healthCheck()).resolves.toBe("needs_credentials");
  });

  it("mints a user-context token via OAuth2 refresh when no static token is set", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "fresh_at", refresh_token: "rot_rt", expires_in: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { id: "user_1", username: "LiveWops" } }), { status: 200 });
    });
    const onRefresh = vi.fn();
    const adapter = createXSocialAdapter({
      env: { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "sec", X_REFRESH_TOKEN: "rt" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRefresh,
    });

    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(onRefresh).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "fresh_at", refreshToken: "rot_rt" }));
    // users/me must be called with the freshly minted bearer.
    expect(fetchImpl).toHaveBeenCalledWith("https://api.x.com/2/users/me", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer fresh_at" }),
    }));
  });

  it("refreshes and retries a publish when the static token has expired (401)", async () => {
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "fresh_at", expires_in: 7200 }), { status: 200 });
      }
      if (target.endsWith("/2/tweets")) {
        postAttempts += 1;
        if (postAttempts === 1) return new Response(JSON.stringify({ title: "Unauthorized" }), { status: 401 });
        return new Response(JSON.stringify({ data: { id: "1999", text: "hi" } }), { status: 201 });
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createXSocialAdapter({
      env: { X_USER_ACCESS_TOKEN: "expired", X_CLIENT_ID: "cid", X_CLIENT_SECRET: "sec", X_REFRESH_TOKEN: "rt" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await adapter.execute("publish", { approvalId: "approval_1", text: "hi" });
    expect(result.status).toBe("completed");
    expect(postAttempts).toBe(2);
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
