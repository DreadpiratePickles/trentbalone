import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockReadPlatformOAuthState,
  mockExchangePlatformOAuthCode,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockReadPlatformOAuthState: vi.fn(),
  mockExchangePlatformOAuthCode: vi.fn(),
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
vi.mock("@/lib/platform-oauth", () => ({
  readPlatformOAuthState: mockReadPlatformOAuthState,
  exchangePlatformOAuthCode: mockExchangePlatformOAuthCode,
}));

import { GET } from "./route";

describe("GET /api/platform/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockReadPlatformOAuthState.mockReturnValue({ companyId: "co_1", kind: "social", platform: "tiktok" });
    mockExchangePlatformOAuthCode.mockResolvedValue({ status: "connected", platform: "tiktok" });
  });

  it("exchanges an OAuth callback inside the state tenant boundary", async () => {
    const res = await GET(new Request("http://x/api/platform/oauth/callback?code=abc&state=encrypted_state"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockReadPlatformOAuthState).toHaveBeenCalledWith("encrypted_state");
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockExchangePlatformOAuthCode).toHaveBeenCalledWith({ code: "abc", state: "encrypted_state" });
    expect(body.result.status).toBe("connected");
  });
});
