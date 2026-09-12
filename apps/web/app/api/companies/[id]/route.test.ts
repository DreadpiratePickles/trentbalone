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

const {
  mockGetCompany,
  mockUpdateCompany,
  mockListAgents,
  mockListTasks,
  mockListRecurringTasks,
  mockListCycles,
  mockListExecutions,
  mockListApprovals,
  mockListDocuments,
  mockListReports,
  mockListUsage,
  mockListIntegrations,
} = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockUpdateCompany: vi.fn(),
  mockListAgents: vi.fn().mockResolvedValue([]),
  mockListTasks: vi.fn().mockResolvedValue([]),
  mockListRecurringTasks: vi.fn().mockResolvedValue([]),
  mockListCycles: vi.fn().mockResolvedValue([]),
  mockListExecutions: vi.fn().mockResolvedValue([]),
  mockListApprovals: vi.fn().mockResolvedValue([]),
  mockListDocuments: vi.fn().mockResolvedValue([]),
  mockListReports: vi.fn().mockResolvedValue([]),
  mockListUsage: vi.fn().mockResolvedValue([]),
  mockListIntegrations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    updateCompany: mockUpdateCompany,
    listAgents: mockListAgents,
    listTasks: mockListTasks,
    listRecurringTasks: mockListRecurringTasks,
    listCycles: mockListCycles,
    listExecutions: mockListExecutions,
    listApprovals: mockListApprovals,
    listDocuments: mockListDocuments,
    listReports: mockListReports,
    listUsage: mockListUsage,
    listIntegrations: mockListIntegrations,
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

import { GET, PATCH, DELETE } from "./route";

describe("/api/companies/[id] RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockUpdateCompany.mockReset();
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  describe("GET", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
      expect(mockGetCompany).toHaveBeenCalledWith("c1");
    });

    it("returns 403 if user lacks viewer role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 and loads company context if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1", name: "Company 1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.company).toEqual({ id: "c1", name: "Company 1" });
    });

    it("returns 429 when rate limit exceeded", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "co1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 20 });
      mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
      const res = await GET(new Request("http://x/api/companies/co1"), { params: Promise.resolve({ id: "co1" }) });
      expect(res.status).toBe(429);
    });
  });

  describe("PATCH", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "New Name" }) }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "New Name" }) }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks admin role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "New Name" }) }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
    });

    it("returns 200 and updates company if admin role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockUpdateCompany.mockResolvedValue({ id: "c1", name: "New Name" });

      const res = await PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "New Name" }) }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.company).toEqual({ id: "c1", name: "New Name" });
    });
  });

  describe("DELETE", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks admin role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
    });

    it("returns 200 and archives company if admin role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockUpdateCompany.mockResolvedValue({ id: "c1", status: "archived" });

      const res = await DELETE(new Request("http://x", { method: "DELETE" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.company.status).toBe("archived");
    });
  });
});
