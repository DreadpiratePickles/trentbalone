import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockRecall,
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
  mockRecall: vi.fn(),
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

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

vi.mock("@/lib/gbrain/gbrain-memory", () => ({ recallMissionContext: mockRecall }));

import { POST } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1" }) };
const RECALL = { status: "ok", source: "local", answer: "prior launches used demos", citations: [{ id: "doc_1", title: "Launch A" }], gaps: [] };

describe("/api/companies/[id]/gbrain/recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockRecall.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return RECALL;
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await POST(new Request("http://x/api/companies/co_1/gbrain/recall", { method: "POST", body: "{}" }), PARAMS);
    expect(res.status).toBe(401);
  });

  it("rejects a missing query", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/gbrain/recall", { method: "POST", body: JSON.stringify({}) }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("recalls mission context for members inside RLS", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/gbrain/recall", {
      method: "POST",
      body: JSON.stringify({ query: "how did past launches go" }),
    }), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockRecall).toHaveBeenCalledWith({ companyId: "co_1", objective: "how did past launches go", limit: undefined });
    expect(body.recall).toEqual(RECALL);
  });
});
