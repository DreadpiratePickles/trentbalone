import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext, mockRefreshPlatformOAuthConnection } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockRefreshPlatformOAuthConnection: vi.fn(),
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
vi.mock("@/lib/platform-oauth", () => ({ refreshPlatformOAuthConnection: mockRefreshPlatformOAuthConnection }));

import { POST } from "./route";

describe("POST /api/platform/oauth/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockRefreshPlatformOAuthConnection.mockResolvedValue({ status: "refreshed", platform: "tiktok" });
  });

  it("refreshes an OAuth connection behind admin auth and RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", kind: "social", platform: "tiktok" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockRefreshPlatformOAuthConnection).toHaveBeenCalledWith({ companyId: "co_1", kind: "social", platform: "tiktok" });
    expect(body.result.status).toBe("refreshed");
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/platform/oauth/refresh", { method: "POST", body: JSON.stringify(body) });
}
