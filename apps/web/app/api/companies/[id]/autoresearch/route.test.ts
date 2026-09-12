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

const { mockGetCompany, mockListApprovals, mockResolveApproval } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockListApprovals: vi.fn().mockResolvedValue([]),
  mockResolveApproval: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listApprovals: mockListApprovals,
    resolveApproval: mockResolveApproval,
  },
}));

const { mockList } = vi.hoisted(() => ({ mockList: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/self-improvement/iteration-log.prisma", () => ({
  PrismaIterationLog: class {
    list = mockList;
  },
}));

const { mockResolvePromotion } = vi.hoisted(() => ({ mockResolvePromotion: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/self-improvement/promotion", () => ({
  resolvePromotion: mockResolvePromotion,
}));

vi.mock("@/lib/self-improvement/skill-draft-store.prisma", () => ({
  PrismaSkillDraftStore: class {},
}));

vi.mock("@/lib/audit-log", () => ({ appendAuditLog: vi.fn() }));

// withRlsContext just invokes the callback (no DB in tests).
vi.mock("@/lib/with-rls", () => ({
  withRlsContext: (_companyId: string, fn: () => unknown) => fn(),
}));

// loadAutoresearchView is only exercised by GET here; stub it to avoid DB.
vi.mock("@/lib/self-improvement/autoresearch-read", () => ({
  loadAutoresearchView: vi.fn().mockResolvedValue({ iterations: [], pending: [] }),
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new Request("http://x", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/companies/[id]/autoresearch", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset().mockResolvedValue({ id: "c1" });
    mockList.mockReset().mockResolvedValue([]);
    mockResolvePromotion.mockReset().mockResolvedValue(undefined);
    mockResolveApproval.mockReset().mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 403 if user lacks viewer role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 with the view when authorized", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ iterations: [], pending: [] });
    });
  });

  describe("POST", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await POST(postReq({ approvalId: "a1", verdict: "approve" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 if user lacks admin role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
      const res = await POST(postReq({ approvalId: "a1", verdict: "approve" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
    });

    it("returns 400 on invalid body", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      const res = await POST(postReq({ approvalId: "a1", verdict: "maybe" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(400);
    });

    it("approve → calls resolvePromotion with verdict 'approve' and resolves the approval", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockList.mockResolvedValue([
        { id: "iter1", approvalId: "a1", taskType: "draft-email", candidateId: "cand1", candidateKind: "skill" },
      ]);
      const res = await POST(postReq({ approvalId: "a1", verdict: "approve" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockResolvePromotion).toHaveBeenCalledTimes(1);
      expect(mockResolvePromotion.mock.calls[0][0]).toBe("approve");
      expect(mockResolvePromotion.mock.calls[0][1]).toMatchObject({
        companyId: "c1",
        taskType: "draft-email",
        candidateId: "cand1",
        candidateKind: "skill",
      });
      expect(mockResolveApproval).toHaveBeenCalledWith("a1", "approved");
    });

    it("reject → calls resolvePromotion with verdict 'reject' and resolves the approval as rejected", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockList.mockResolvedValue([
        { id: "iter1", approvalId: "a1", taskType: "draft-email", candidateId: "cand1", candidateKind: "prompt" },
      ]);
      const res = await POST(postReq({ approvalId: "a1", verdict: "reject" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(200);
      expect(mockResolvePromotion.mock.calls[0][0]).toBe("reject");
      expect(mockResolvePromotion.mock.calls[0][1]).toMatchObject({ candidateKind: "prompt" });
      expect(mockResolveApproval).toHaveBeenCalledWith("a1", "rejected");
    });

    it("returns 404 when no iteration matches the approvalId", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockList.mockResolvedValue([]);
      const res = await POST(postReq({ approvalId: "missing", verdict: "approve" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(404);
      expect(mockResolvePromotion).not.toHaveBeenCalled();
    });

    it("falls back candidateKind to 'skill' when iteration omits it", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
      mockList.mockResolvedValue([{ id: "iter1", approvalId: "a1", taskType: "draft-email", candidateId: "cand1" }]);
      const res = await POST(postReq({ approvalId: "a1", verdict: "approve" }), {
        params: Promise.resolve({ id: "c1" }),
      });
      expect(res.status).toBe(200);
      expect(mockResolvePromotion.mock.calls[0][1]).toMatchObject({ candidateKind: "skill" });
    });
  });
});
