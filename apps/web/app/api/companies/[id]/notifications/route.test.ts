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

const { mockGetCompany, mockListApprovals, mockListArtifacts, mockListCycles } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockListApprovals: vi.fn().mockResolvedValue([]),
  mockListArtifacts: vi.fn().mockResolvedValue([]),
  mockListCycles: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listApprovals: mockListApprovals,
    listArtifacts: mockListArtifacts,
    listCycles: mockListCycles,
  },
}));

import { GET } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/notifications RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockListApprovals.mockReset();
    mockListArtifacts.mockReset();
    mockListCycles.mockReset();

    mockListApprovals.mockResolvedValue([]);
    mockListArtifacts.mockResolvedValue([]);
    mockListCycles.mockResolvedValue([]);
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
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 and loads notifications if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.notifications).toBeDefined();
    });
  });
});
