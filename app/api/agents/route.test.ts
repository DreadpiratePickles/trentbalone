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

const { mockListAgents, mockGetAgent, mockUpdateAgent } = vi.hoisted(() => ({
  mockListAgents: vi.fn().mockResolvedValue([]),
  mockGetAgent: vi.fn(),
  mockUpdateAgent: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    listAgents: mockListAgents,
    getAgent: mockGetAgent,
    updateAgent: mockUpdateAgent,
  },
}));

const { mockCheckRateLimit, mockRateLimitExceeded } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

import { GET, PATCH } from "./route";

describe("/api/agents RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockListAgents.mockReset();
    mockGetAgent.mockReset();
    mockUpdateAgent.mockReset();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  describe("GET", () => {
    it("returns 401 when unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await GET(new Request("http://x/api/agents?companyId=c1"));
      expect(res.status).toBe(401);
    });

    it("returns 403 when user lacks viewer role on companyId", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
      const res = await GET(new Request("http://x/api/agents?companyId=c1"));
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 and lists agents when viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockListAgents.mockResolvedValue([{ id: "a1", name: "Agent 1" }]);

      const res = await GET(new Request("http://x/api/agents?companyId=c1"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ agents: [{ id: "a1", name: "Agent 1" }] });
    });

    it("returns 429 when rate limit exceeded", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 20 });
      mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
      const res = await GET(new Request("http://x/api/agents?companyId=co1"));
      expect(res.status).toBe(429);
    });
  });

  describe("PATCH", () => {
    it("returns 401 when unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await PATCH(new Request("http://x/api/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: "a1", name: "Updated" }),
      }));
      expect(res.status).toBe(401);
    });

    it("returns 404 if the agent is not found", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetAgent.mockResolvedValue(null);
      
      const res = await PATCH(new Request("http://x/api/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: "a1", name: "Updated" }),
      }));
      expect(res.status).toBe(404);
      expect(mockGetAgent).toHaveBeenCalledWith("a1");
    });

    it("returns 403 when user lacks admin role on agent's companyId", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetAgent.mockResolvedValue({ id: "a1", companyId: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await PATCH(new Request("http://x/api/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: "a1", name: "Updated" }),
      }));
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
    });

    it("returns 200 and updates agent when admin role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetAgent.mockResolvedValue({ id: "a1", companyId: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockUpdateAgent.mockResolvedValue({ id: "a1", name: "Updated" });

      const res = await PATCH(new Request("http://x/api/agents", {
        method: "PATCH",
        body: JSON.stringify({ id: "a1", name: "Updated" }),
      }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ agent: { id: "a1", name: "Updated" } });
    });
  });
});
