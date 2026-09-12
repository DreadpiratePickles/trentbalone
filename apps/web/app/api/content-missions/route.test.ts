import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockListContentMissionRuns,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockListContentMissionRuns: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: () => new Response("rate limited", { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    listContentMissionRuns: mockListContentMissionRuns,
  },
}));

import { GET } from "./route";

const RUN = {
  id: "orc_abc",
  companyId: "co_1",
  runId: "orc_abc",
  objective: "Publish viral TikTok content",
  operatingMode: "draft_only_until_approval",
  status: "completed",
  ownerSeat: "ceo",
  externalActionStatus: "EXECUTED",
  requiredSocialPlatforms: ["tiktok"],
  requiredMarketingPlatforms: [],
  socialPublishingRequested: true,
  paidAdsRequested: false,
  approvalGates: [],
  memoryLogFields: [],
  creativeApps: [],
  budgetCents: 0,
  costCents: 0,
  startedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

describe("GET /api/content-missions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockListContentMissionRuns.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [RUN];
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/content-missions?companyId=co_1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await GET(new Request("http://x/api/content-missions"));
    expect(res.status).toBe(400);
  });

  it("returns 403 when user lacks viewer role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/content-missions?companyId=co_1"));
    expect(res.status).toBe(403);
  });

  it("returns the mission list inside RLS context", async () => {
    const res = await GET(new Request("http://x/api/content-missions?companyId=co_1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.missions).toHaveLength(1);
    expect(body.missions[0].id).toBe("orc_abc");
  });
});
