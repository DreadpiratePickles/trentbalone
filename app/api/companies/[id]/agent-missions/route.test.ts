import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockListAgentMissionRuns,
  mockRunAgentMission,
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
  mockListAgentMissionRuns: vi.fn(),
  mockRunAgentMission: vi.fn(),
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
    listAgentMissionRuns: mockListAgentMissionRuns,
  },
}));

vi.mock("@/lib/agent-mission-runtime", () => ({
  runAgentMission: mockRunAgentMission,
}));

import { GET, POST } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1" }) };
const RUN = {
  id: "amr_1",
  companyId: "co_1",
  objective: "Produce content and publish",
  missionType: "content_social_ads",
  status: "awaiting_approval",
  trigger: "command",
  ownerSeat: "ceo",
  budgetCents: 5000,
  costCents: 0,
  approvalPolicy: {},
  modelPolicy: {},
  startedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z",
};

describe("/api/companies/[id]/agent-missions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockListAgentMissionRuns.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [RUN];
    });
    mockRunAgentMission.mockResolvedValue({ run: RUN, steps: [], events: [], approvals: [], artifacts: [], finalSummary: "CEO Mission Report" });
  });

  it("GET returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions"), PARAMS);
    expect(res.status).toBe(401);
  });

  it("GET returns missions inside RLS context for viewers", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions"), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.missions).toEqual([RUN]);
  });

  it("POST rejects missing objective", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/agent-missions", {
      method: "POST",
      body: JSON.stringify({}),
    }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("POST starts an approval-gated mission inside RLS context for members", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/agent-missions", {
      method: "POST",
      body: JSON.stringify({ objective: "Produce content and publish", budgetCents: 7500 }),
    }), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockRunAgentMission).toHaveBeenCalledWith({
      companyId: "co_1",
      objective: "Produce content and publish",
      trigger: "command",
      budgetCents: 7500,
    });
    expect(body.run.id).toBe("amr_1");
    expect(body.finalSummary).toContain("CEO Mission Report");
  });
});
