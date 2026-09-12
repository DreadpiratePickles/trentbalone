import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext, mockBuildPlatformOAuthStart } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockBuildPlatformOAuthStart: vi.fn(),
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
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/platform-oauth", () => ({ buildPlatformOAuthStart: mockBuildPlatformOAuthStart }));

import { POST } from "./route";

describe("POST /api/platform/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockBuildPlatformOAuthStart.mockReturnValue({
      authorizationUrl: "https://oauth.example/authorize",
      state: "encrypted_state",
      provider: "Social:TikTok",
      scopes: ["video.upload"],
    });
  });

  it("creates an authorization URL behind admin auth and RLS", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      kind: "social",
      platform: "tiktok",
      redirectUri: "https://trent.test/api/platform/oauth/callback",
      externalAccountId: "creator_1",
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.authorizationUrl).toBe("https://oauth.example/authorize");
    expect(body).not.toHaveProperty("codeVerifier");
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/platform/oauth/start", { method: "POST", body: JSON.stringify(body) });
}
