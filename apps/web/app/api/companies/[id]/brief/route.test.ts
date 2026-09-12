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

const { mockGetCompany, mockUpdateCompany } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockUpdateCompany: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    updateCompany: mockUpdateCompany,
  },
}));

import { GET, POST } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/brief RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockUpdateCompany.mockReset();
  });

  describe("GET", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks viewer role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1", brief: {} });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 and loads brief if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1", brief: { name: "Brief 1" } });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.brief).toEqual({ name: "Brief 1" });
    });
  });

  describe("POST", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks admin role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
    });

    it("returns 200 and updates brief if admin role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1", brief: { name: "Brief 1" } });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockUpdateCompany.mockResolvedValue({ id: "c1", brief: { name: "Updated Brief" } });

      const res = await POST(
        makeMockRequest("http://x", { method: "POST", body: JSON.stringify({ name: "Updated Brief" }) }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.brief).toEqual({ name: "Updated Brief" });
    });
  });
});
