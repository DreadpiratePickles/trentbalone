import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetContentMissionRun,
  mockListContentMissionActions,
  mockGetArtifact,
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
  mockGetContentMissionRun: vi.fn(),
  mockListContentMissionActions: vi.fn(),
  mockGetArtifact: vi.fn(),
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
    getContentMissionRun: mockGetContentMissionRun,
    listContentMissionActions: mockListContentMissionActions,
    getArtifact: mockGetArtifact,
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
  memoryLogArtifactId: "artifact_1",
  startedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

const ACTION = {
  id: "orc_abc:action_public_publish",
  runId: "orc_abc",
  companyId: "co_1",
  ledgerItemId: "action_public_publish",
  kind: "public_publish",
  owner: "ceo",
  status: "executed",
  approvalGate: "public_publish",
  sourceStage: "ceo_approval_packet",
  reason: "published",
  relatedPlatforms: ["tiktok"],
  createdAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

const ARTIFACT = {
  id: "artifact_1",
  companyId: "co_1",
  type: "operating_memo",
  status: "ready",
  title: "Memory log",
  content: "# Content Mission Memory Log",
  storageKey: "content-mission/orc_abc/memory-log.md",
};

describe("GET /api/content-missions/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetContentMissionRun.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return RUN;
    });
    mockListContentMissionActions.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [ACTION];
    });
    mockGetArtifact.mockResolvedValue(ARTIFACT);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/content-missions/orc_abc?companyId=co_1"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when companyId is missing", async () => {
    const res = await GET(new Request("http://x/api/content-missions/orc_abc"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 when user lacks viewer role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/content-missions/orc_abc?companyId=co_1"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when mission is not found", async () => {
    mockGetContentMissionRun.mockResolvedValue(undefined);
    const res = await GET(new Request("http://x/api/content-missions/missing?companyId=co_1"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when mission belongs to a different company", async () => {
    mockGetContentMissionRun.mockResolvedValue({ ...RUN, companyId: "co_other" });
    const res = await GET(new Request("http://x/api/content-missions/orc_abc?companyId=co_1"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns mission, actions, and memory log artifact inside RLS context", async () => {
    const res = await GET(new Request("http://x/api/content-missions/orc_abc?companyId=co_1"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.mission.id).toBe("orc_abc");
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].kind).toBe("public_publish");
    expect(body.memoryLog.id).toBe("artifact_1");
    expect(body.memoryLog.type).toBe("operating_memo");
  });

  it("returns null memoryLog when no artifact id is set on the run", async () => {
    mockGetContentMissionRun.mockResolvedValue({ ...RUN, memoryLogArtifactId: undefined });
    const res = await GET(new Request("http://x/api/content-missions/orc_abc?companyId=co_1"), {
      params: Promise.resolve({ id: "orc_abc" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.memoryLog).toBeNull();
    expect(mockGetArtifact).not.toHaveBeenCalled();
  });
});
