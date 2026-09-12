import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetAgentMissionRun,
  mockListAgentMissionEvents,
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
  mockGetAgentMissionRun: vi.fn(),
  mockListAgentMissionEvents: vi.fn(),
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
    getAgentMissionRun: mockGetAgentMissionRun,
    listAgentMissionEvents: mockListAgentMissionEvents,
  },
}));

import { GET } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1", runId: "amr_1" }) };

describe("GET /api/companies/[id]/agent-missions/[runId]/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetAgentMissionRun.mockResolvedValue({ id: "amr_1", companyId: "co_1" });
    mockListAgentMissionEvents.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return [
        { id: "event_1", seq: 1, kind: "run_start" },
        { id: "event_2", seq: 2, kind: "run_done" },
      ];
    });
  });

  it("returns replayable events for the mission", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions/amr_1/events"), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.map((event: { kind: string }) => event.kind)).toEqual(["run_start", "run_done"]);
  });

  it("returns 404 for another company's mission", async () => {
    mockGetAgentMissionRun.mockResolvedValue({ id: "amr_1", companyId: "co_other" });
    const res = await GET(new Request("http://x/api/companies/co_1/agent-missions/amr_1/events"), PARAMS);
    expect(res.status).toBe(404);
  });
});
