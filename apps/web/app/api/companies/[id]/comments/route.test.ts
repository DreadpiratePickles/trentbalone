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

const { mockGetCompany, mockListComments, mockAddComment } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockListComments: vi.fn().mockResolvedValue([]),
  mockAddComment: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listComments: mockListComments,
    addComment: mockAddComment,
  },
}));

import { GET, POST } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/comments RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockListComments.mockReset();
    mockAddComment.mockReset();
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

    it("returns 200 and loads comments if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockListComments.mockResolvedValue([{ id: "com1", content: "Great" }]);

      const res = await GET(
        makeMockRequest("http://x/api/companies/c1/comments?entityType=task&entityId=t1"),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.comments).toEqual([{ id: "com1", content: "Great" }]);
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

    it("returns 403 if user lacks member role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
    });

    it("returns 201 and adds comment if member role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1", name: "User One" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockAddComment.mockResolvedValue({ id: "com1", content: "Hello" });

      const res = await POST(
        makeMockRequest("http://x", {
          method: "POST",
          body: JSON.stringify({ entityType: "task", entityId: "t1", content: "Hello" }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.comment).toEqual({ id: "com1", content: "Hello" });
    });
  });
});
