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

const { mockGetCompany, mockListExecutions, mockListAuditLogs, mockListApprovals, mockListArtifacts } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockListExecutions: vi.fn().mockResolvedValue([]),
  mockListAuditLogs: vi.fn().mockResolvedValue([]),
  mockListApprovals: vi.fn().mockResolvedValue([]),
  mockListArtifacts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listExecutions: mockListExecutions,
    listAuditLogs: mockListAuditLogs,
    listApprovals: mockListApprovals,
    listArtifacts: mockListArtifacts,
  },
}));

import { GET } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/activity RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockListExecutions.mockReset().mockResolvedValue([]);
    mockListAuditLogs.mockReset().mockResolvedValue([]);
    mockListApprovals.mockReset().mockResolvedValue([]);
    mockListArtifacts.mockReset().mockResolvedValue([]);
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

    it("returns 200 and loads activity feed if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

      mockListExecutions.mockResolvedValue([
        { id: "e1", agentRole: "researcher", status: "completed", costCents: 10, createdAt: "2026-05-28T17:00:00Z", output: "Found details" }
      ]);
      mockListAuditLogs.mockResolvedValue([
        { id: "log1", actor: "agent", objectType: "researcher", summary: "Researched stuff", createdAt: "2026-05-28T17:05:00Z" }
      ]);
      mockListApprovals.mockResolvedValue([
        { id: "ap1", action: "Deploy", status: "approved", createdAt: "2026-05-28T17:10:00Z", resolvedAt: "2026-05-28T17:11:00Z" }
      ]);
      mockListArtifacts.mockResolvedValue([
        { id: "art1", type: "report", title: "Summary Report", status: "final", createdByAgent: "reporter", createdAt: "2026-05-28T17:15:00Z" }
      ]);

      const res = await GET(
        makeMockRequest("http://x/api/companies/c1/activity?limit=10"),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      
      expect(body.activity).toBeDefined();
      expect(body.activity.length).toBe(4);
      // Verify sorting descending by createdAt (artifact > approval > audit > execution)
      expect(body.activity[0].kind).toBe("artifact");
      expect(body.activity[1].kind).toBe("approval");
      expect(body.activity[2].kind).toBe("audit");
      expect(body.activity[3].kind).toBe("execution");
    });
  });
});
