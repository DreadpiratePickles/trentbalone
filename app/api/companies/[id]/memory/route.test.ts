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

const { mockGetCompany, mockSearchMemory, mockUpdateDocument } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockSearchMemory: vi.fn().mockResolvedValue([]),
  mockUpdateDocument: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    searchMemory: mockSearchMemory,
    updateDocument: mockUpdateDocument,
  },
}));

import { GET, PATCH } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/memory RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockSearchMemory.mockReset();
    mockUpdateDocument.mockReset();
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

    it("returns 200 and searches memory if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockSearchMemory.mockResolvedValue([{ id: "doc1", title: "Memory 1", content: "Content 1" }]);

      const res = await GET(
        makeMockRequest("http://x/api/companies/c1/memory?q=test"),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([{ id: "doc1", title: "Memory 1", content: "Content 1" }]);
      expect(mockSearchMemory).toHaveBeenCalledWith("c1", "test");
    });
  });

  describe("PATCH", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await PATCH(makeMockRequest("http://x", { method: "PATCH" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await PATCH(makeMockRequest("http://x", { method: "PATCH" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks member role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await PATCH(makeMockRequest("http://x", { method: "PATCH" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
    });

    it("returns 400 if docId is missing", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

      const res = await PATCH(
        makeMockRequest("http://x", {
          method: "PATCH",
          body: JSON.stringify({ title: "Updated" }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 if document is not found", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockUpdateDocument.mockResolvedValue(null);

      const res = await PATCH(
        makeMockRequest("http://x", {
          method: "PATCH",
          body: JSON.stringify({ docId: "doc1", title: "Updated" }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(404);
    });

    it("returns 200 and updates document if member role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockUpdateDocument.mockResolvedValue({ id: "doc1", title: "Updated", content: "New content" });

      const res = await PATCH(
        makeMockRequest("http://x", {
          method: "PATCH",
          body: JSON.stringify({ docId: "doc1", title: "Updated", content: "New content" }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.document).toEqual({ id: "doc1", title: "Updated", content: "New content" });
      expect(mockUpdateDocument).toHaveBeenCalledWith("doc1", { title: "Updated", content: "New content" });
    });
  });
});
