import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleConsentUrl, exchangeCodeForTokens } from "@/lib/google/google-oauth";
import type { GoogleFetch } from "@/lib/google/google-client";

const ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI"] as const;
function clearEnv() { for (const k of ENV) delete process.env[k]; }

describe("buildGoogleConsentUrl", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("throws when the OAuth app is not configured", () => {
    expect(() => buildGoogleConsentUrl({ state: "s1" })).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("builds an offline consent url with the requested scopes and state", () => {
    process.env.GOOGLE_CLIENT_ID = "client_123";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.trent.example/api/operator/google/oauth/callback";
    const url = new URL(buildGoogleConsentUrl({ state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("scope")).toContain("gmail");
  });
});

describe("exchangeCodeForTokens", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it("exchanges an auth code for credentials", async () => {
    process.env.GOOGLE_CLIENT_ID = "client_123";
    process.env.GOOGLE_CLIENT_SECRET = "secret_xyz";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.trent.example/cb";
    let sentBody = "";
    const fetchImpl: GoogleFetch = vi.fn(async (_url, init) => {
      sentBody = init.body ?? "";
      return { ok: true, status: 200, json: async () => ({ refresh_token: "rt_new", access_token: "at_new", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.send" }) };
    });

    const creds = await exchangeCodeForTokens("auth_code_1", fetchImpl);
    expect(sentBody).toContain("grant_type=authorization_code");
    expect(sentBody).toContain("code=auth_code_1");
    expect(creds.refreshToken).toBe("rt_new");
    expect(creds.accessToken).toBe("at_new");
    expect(creds.scopes).toContain("https://www.googleapis.com/auth/gmail.send");
  });

  it("throws when Google returns no refresh token", async () => {
    process.env.GOOGLE_CLIENT_ID = "client_123";
    process.env.GOOGLE_CLIENT_SECRET = "secret_xyz";
    process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://app.trent.example/cb";
    const fetchImpl: GoogleFetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "at_new", expires_in: 3600 }) }));
    await expect(exchangeCodeForTokens("code", fetchImpl)).rejects.toThrow(/refresh token/i);
  });
});
