import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockGetSocialAccount,
  mockUpsertSocialAnalyticsSnapshot,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockGetCompany: vi.fn(),
  mockGetSocialAccount: vi.fn(),
  mockUpsertSocialAnalyticsSnapshot: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    getSocialAccount: mockGetSocialAccount,
    upsertSocialAnalyticsSnapshot: mockUpsertSocialAnalyticsSnapshot,
  },
}));

import { POST } from "./route";

describe("/api/social/analytics/weekly-report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockGetSocialAccount.mockImplementation(async (companyId: string, accountId: string) => {
      expect(rlsState.active).toBe(true);
      return {
        id: accountId,
        companyId,
        platform: accountId.endsWith("li") ? "linkedin" : "x",
        status: "active",
        externalAccountId: `external_${accountId}`,
        autoPublishEnabled: false,
      };
    });
    mockUpsertSocialAnalyticsSnapshot.mockImplementation(async (input) => {
      expect(rlsState.active).toBe(true);
      return {
        ...input,
        id: `snapshot_${input.socialAccountId}`,
        createdAt: "2026-05-29T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
      };
    });
  });

  it("requires auth, member role, rate limit, RLS, and returns aggregated weekly report", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      periodStart: "2026-05-18T00:00:00.000Z",
      periodEnd: "2026-05-25T00:00:00.000Z",
      accountMetrics: [
        { socialAccountId: "acct_x", metrics: { impressions: 1000, reach: 900, engagements: 100 } },
        { socialAccountId: "acct_li", metrics: { impressions: 2000, reach: 1800, engagements: 260 } },
      ],
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockUpsertSocialAnalyticsSnapshot).toHaveBeenCalledTimes(2);
    expect(body.report.aggregate.totals.impressions).toBe(3000);
    expect(body.report.aggregate.engagementRate).toBe(0.12);
  });

  it("rejects malformed input before RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", accountMetrics: [] }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockUpsertSocialAnalyticsSnapshot).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/social/analytics/weekly-report", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
