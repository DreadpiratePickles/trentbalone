import { describe, expect, it, vi } from "vitest";
import { refreshXAccessToken, xRefreshConfigured } from "@/lib/x-oauth";

describe("x-oauth refresh", () => {
  it("detects when refresh is configured", () => {
    expect(xRefreshConfigured({ X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "rt" })).toBe(true);
    expect(xRefreshConfigured({ X_CLIENT_ID: "cid" })).toBe(false);
    expect(xRefreshConfigured({})).toBe(false);
  });

  it("exchanges the refresh token for a fresh access token with Basic auth", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe("https://api.x.com/2/oauth2/token");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
      const body = (init.body as URLSearchParams).toString();
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=rt-old");
      return new Response(
        JSON.stringify({
          token_type: "bearer",
          access_token: "at-new",
          refresh_token: "rt-new",
          expires_in: 7200,
          scope: "tweet.write tweet.read users.read offline.access",
        }),
        { status: 200 },
      );
    });

    const result = await refreshXAccessToken(
      { X_CLIENT_ID: "cid", X_CLIENT_SECRET: "secret", X_REFRESH_TOKEN: "rt-old" },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.accessToken).toBe("at-new");
    expect(result.refreshToken).toBe("rt-new");
    expect(result.expiresIn).toBe(7200);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws a clear error when X rejects the refresh", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_request", error_description: "refresh token expired" }), {
        status: 400,
      }),
    );
    await expect(
      refreshXAccessToken({ X_CLIENT_ID: "cid", X_REFRESH_TOKEN: "rt" }, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/refresh token expired/);
  });

  it("requires client id and refresh token", async () => {
    await expect(refreshXAccessToken({}, vi.fn() as unknown as typeof fetch)).rejects.toThrow(
      /X_CLIENT_ID and X_REFRESH_TOKEN/,
    );
  });
});
