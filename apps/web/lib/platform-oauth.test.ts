import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSaveSocialPlatformConnection, mockSaveMarketingPlatformConnection, mockGetIntegration } = vi.hoisted(() => ({
  mockSaveSocialPlatformConnection: vi.fn(),
  mockSaveMarketingPlatformConnection: vi.fn(),
  mockGetIntegration: vi.fn(),
}));

vi.mock("@/lib/platform-connections", () => ({
  saveSocialPlatformConnection: mockSaveSocialPlatformConnection,
  saveMarketingPlatformConnection: mockSaveMarketingPlatformConnection,
}));
vi.mock("@/lib/store", () => ({
  store: { getIntegration: mockGetIntegration, upsertIntegration: vi.fn(async (input) => ({ ...input, id: "connection_1", lastCheckedAt: "2026-06-06T00:00:00.000Z" })) },
}));

import { decryptJson, encryptJson } from "@/lib/secrets";
import {
  buildPlatformOAuthStart,
  exchangePlatformOAuthCode,
  refreshPlatformOAuthConnection,
} from "./platform-oauth";

describe("platform oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TIKTOK_CLIENT_KEY = "tiktok_client";
    process.env.TIKTOK_CLIENT_SECRET = "tiktok_secret";
    process.env.GOOGLE_CLIENT_ID = "google_client";
    process.env.GOOGLE_CLIENT_SECRET = "google_secret";
    process.env.META_CLIENT_ID = "meta_client";
    process.env.META_CLIENT_SECRET = "meta_secret";
  });

  it("builds a provider authorization URL with encrypted state and PKCE but no client secret", () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "social",
      platform: "tiktok",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
      externalAccountId: "creator_1",
    });

    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("client_key")).toBe("tiktok_client");
    expect(url.searchParams.get("state")).toBe(start.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.state).not.toContain("tiktok_secret");
    expect(decryptJson<{ codeVerifier: string }>(start.state).codeVerifier).toHaveLength(64);
  });

  it("exchanges a TikTok auth code and persists a social connection without echoing secrets", async () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "social",
      platform: "tiktok",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
    });
    const tokenFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "live_access_token",
        refresh_token: "live_refresh_token",
        expires_in: 3600,
        refresh_expires_in: 86400,
        scope: "user.info.basic,video.upload",
        open_id: "tiktok_open_id",
      }),
      text: async () => "",
    });
    mockSaveSocialPlatformConnection.mockResolvedValue({
      connection: { id: "connection_social", encryptedData: "secret" },
      account: { id: "social_1", externalAccountId: "tiktok_open_id" },
    });

    const result = await exchangePlatformOAuthCode({
      code: "auth_code",
      state: start.state,
      fetchImpl: tokenFetch,
    });

    expect(tokenFetch).toHaveBeenCalledWith("https://open.tiktokapis.com/v2/oauth/token/", expect.objectContaining({ method: "POST" }));
    expect(mockSaveSocialPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "tiktok",
      accessToken: "live_access_token",
      externalAccountId: "tiktok_open_id",
      scopes: ["user.info.basic", "video.upload"],
    }));
    expect(JSON.stringify(result.safeConnection)).not.toContain("live_access_token");
    expect(result.account.externalAccountId).toBe("tiktok_open_id");
  });

  it("fails closed when the callback cannot determine an external account id", async () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "social",
      platform: "youtube",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
    });
    const tokenFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "youtube_access", refresh_token: "youtube_refresh" }),
      text: async () => "",
    });

    await expect(exchangePlatformOAuthCode({
      code: "auth_code",
      state: start.state,
      fetchImpl: tokenFetch,
    })).rejects.toThrow("externalAccountId");
    expect(mockSaveSocialPlatformConnection).not.toHaveBeenCalled();
  });

  it("discovers a Facebook Page account during OAuth exchange when no account id was supplied", async () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "social",
      platform: "facebook",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
    });
    const tokenFetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/access_token")) {
        return okJson({
          access_token: "meta_user_access",
          refresh_token: "meta_refresh",
          expires_in: 3600,
        });
      }
      if (href.includes("/me/accounts")) {
        return okJson({
          data: [{
            id: "page_123",
            name: "Trent Page",
            access_token: "page_access_token",
          }],
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    mockSaveSocialPlatformConnection.mockResolvedValue({
      connection: { id: "connection_facebook", encryptedData: "secret" },
      account: { id: "social_fb", externalAccountId: "page_123" },
    });

    const result = await exchangePlatformOAuthCode({
      code: "auth_code",
      state: start.state,
      fetchImpl: tokenFetch as typeof fetch,
    });

    expect(tokenFetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v20.0/me/accounts?fields=id%2Cname%2Caccess_token%2Cinstagram_business_account%7Bid%2Cusername%7D",
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockSaveSocialPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "facebook",
      accessToken: "page_access_token",
      externalAccountId: "page_123",
      displayName: "Trent Page",
    }));
    expect(JSON.stringify(result.safeConnection)).not.toContain("page_access_token");
  });

  it("discovers an Instagram business account during OAuth exchange when no account id was supplied", async () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "social",
      platform: "instagram",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
    });
    const tokenFetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/access_token")) {
        return okJson({
          access_token: "meta_user_access",
          refresh_token: "meta_refresh",
          expires_in: 3600,
        });
      }
      if (href.includes("/me/accounts")) {
        return okJson({
          data: [{
            id: "page_123",
            name: "Trent Page",
            access_token: "page_access_token",
            instagram_business_account: {
              id: "ig_business_123",
              username: "trentstudio",
            },
          }],
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    mockSaveSocialPlatformConnection.mockResolvedValue({
      connection: { id: "connection_instagram", encryptedData: "secret" },
      account: { id: "social_ig", externalAccountId: "ig_business_123" },
    });

    const result = await exchangePlatformOAuthCode({
      code: "auth_code",
      state: start.state,
      fetchImpl: tokenFetch as typeof fetch,
    });

    expect(mockSaveSocialPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "instagram",
      accessToken: "page_access_token",
      externalAccountId: "ig_business_123",
      externalHandle: "trentstudio",
      displayName: "Trent Page",
    }));
    expect(JSON.stringify(result.safeConnection)).not.toContain("page_access_token");
  });

  it("discovers a Meta ad account during ads OAuth exchange when no account id was supplied", async () => {
    const start = buildPlatformOAuthStart({
      companyId: "co_1",
      kind: "ads",
      platform: "meta",
      redirectUri: "https://app.trent.test/api/platform/oauth/callback",
    });
    const tokenFetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/oauth/access_token")) {
        return okJson({
          access_token: "meta_ads_access",
          refresh_token: "meta_ads_refresh",
          expires_in: 3600,
        });
      }
      if (href.includes("/me/adaccounts")) {
        return okJson({
          data: [{
            id: "act_987654321",
            account_id: "987654321",
            name: "Trent Ads",
            currency: "USD",
            account_status: 1,
            business: {
              id: "biz_123",
              name: "Trent Business",
            },
          }],
        });
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    mockSaveMarketingPlatformConnection.mockResolvedValue({
      connection: { id: "connection_meta_ads", encryptedData: "secret" },
      account: { id: "marketing_meta", externalAccountId: "act_987654321" },
    });

    const result = await exchangePlatformOAuthCode({
      code: "auth_code",
      state: start.state,
      fetchImpl: tokenFetch as typeof fetch,
    });

    expect(tokenFetch).toHaveBeenCalledWith(
      "https://graph.facebook.com/v20.0/me/adaccounts?fields=id%2Caccount_id%2Cname%2Ccurrency%2Caccount_status%2Cbusiness%7Bid%2Cname%7D",
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockSaveMarketingPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "meta",
      accessToken: "meta_ads_access",
      externalAccountId: "act_987654321",
      externalBusinessId: "biz_123",
      currency: "USD",
    }));
    expect(JSON.stringify(result.safeConnection)).not.toContain("meta_ads_access");
  });

  it("refreshes a stored OAuth token through the provider token endpoint", async () => {
    const encryptedData = encryptJson({
      kind: "social",
      platform: "tiktok",
      accessToken: "old_access",
      refreshToken: "old_refresh",
      externalAccountId: "creator_1",
      scopes: ["user.info.basic"],
    });
    mockGetIntegration.mockResolvedValue({
      companyId: "co_1",
      provider: "Social:TikTok",
      scopes: ["user.info.basic"],
      status: "connected",
      encryptedData,
    });
    const tokenFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new_access",
        refresh_token: "new_refresh",
        expires_in: 3600,
        scope: "user.info.basic",
      }),
      text: async () => "",
    });

    const result = await refreshPlatformOAuthConnection({
      companyId: "co_1",
      kind: "social",
      platform: "tiktok",
      fetchImpl: tokenFetch,
    });

    expect(result.status).toBe("refreshed");
    expect(tokenFetch).toHaveBeenCalledWith("https://open.tiktokapis.com/v2/oauth/token/", expect.objectContaining({ method: "POST" }));
  });
});

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}
