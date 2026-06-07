import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

const { mockCheckRateLimit, mockRateLimitExceeded } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/store", () => ({
  store: {
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({ id: "t1" }),
  }
}));

import { GET, POST } from "./route";

describe("/api/tasks RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("GET: returns 403 when caller lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await GET(new Request("http://x/api/tasks?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when caller lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = new Request("http://x/api/tasks", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", title: "Task 1", prompt: "Do it", agentRole: "engineer" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  describe("GET rate limiting", () => {
    it("returns 429 when rate limit exceeded", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 20 });
      mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
      const res = await GET(new Request("http://x/api/tasks?companyId=co1"));
      expect(res.status).toBe(429);
    });
  });
});
