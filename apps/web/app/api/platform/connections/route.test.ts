import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockListPlatformConnectionStatuses,
  mockSaveSocialPlatformConnection,
  mockSaveMarketingPlatformConnection,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockListPlatformConnectionStatuses: vi.fn(),
  mockSaveSocialPlatformConnection: vi.fn(),
  mockSaveMarketingPlatformConnection: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => new Response(String(retryAfterSeconds), { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: { getCompany: mockGetCompany },
}));

vi.mock("@/lib/platform-connections", () => ({
  listPlatformConnectionStatuses: mockListPlatformConnectionStatuses,
  saveSocialPlatformConnection: mockSaveSocialPlatformConnection,
  saveMarketingPlatformConnection: mockSaveMarketingPlatformConnection,
}));

import { GET, POST } from "./route";

describe("/api/platform/connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockListPlatformConnectionStatuses.mockResolvedValue({ social: [], marketing: [] });
    mockSaveSocialPlatformConnection.mockResolvedValue({
      connection: { id: "connection_social", provider: "Social:TikTok", status: "connected" },
      account: { id: "social_1", platform: "tiktok", credentialsRef: "connection_social" },
    });
    mockSaveMarketingPlatformConnection.mockResolvedValue({
      connection: { id: "connection_ads", provider: "Ads:Meta", status: "connected" },
      account: { id: "marketing_1", platform: "meta" },
    });
  });

  it("GET returns masked platform connection statuses with viewer auth", async () => {
    const res = await GET(new Request("http://x/api/platform/connections?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockListPlatformConnectionStatuses).toHaveBeenCalledWith("co_1");
  });

  it("POST connects a social platform without echoing the raw token", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      kind: "social",
      platform: "tiktok",
      accessToken: "tiktok_token_123456789",
      externalAccountId: "acct_tiktok",
      scopes: ["post:write"],
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockSaveSocialPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "tiktok",
      accessToken: "tiktok_token_123456789",
    }));
    expect(JSON.stringify(body)).not.toContain("tiktok_token_123456789");
  });

  it("POST connects an ads platform without echoing the raw token", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      kind: "ads",
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta",
      externalBusinessId: "biz_meta",
      currency: "USD",
      dailyBudgetCents: 2500,
      consentForServerEvents: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockSaveMarketingPlatformConnection).toHaveBeenCalledWith("co_1", expect.objectContaining({
      platform: "meta",
      accessToken: "meta_token_123456789",
    }));
    expect(JSON.stringify(body)).not.toContain("meta_token_123456789");
  });

  it("rejects unsupported connection kinds before saving", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", kind: "ftp", platform: "meta", accessToken: "secret" }));

    expect(res.status).toBe(400);
    expect(mockSaveSocialPlatformConnection).not.toHaveBeenCalled();
    expect(mockSaveMarketingPlatformConnection).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/platform/connections", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
