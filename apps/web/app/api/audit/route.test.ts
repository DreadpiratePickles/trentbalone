import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRole, mockCanAccessCompany, mockGetUserCompanyIds } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRole: vi.fn(),
  mockCanAccessCompany: vi.fn(),
  mockGetUserCompanyIds: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRole: mockRequireRole,
  canAccessCompany: mockCanAccessCompany,
  getUserCompanyIds: mockGetUserCompanyIds,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));
vi.mock("@/lib/store", () => ({ store: { listAuditLogs: vi.fn().mockResolvedValue([]) } }));

import { GET } from "./route";

describe("GET /api/audit RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRole.mockReset();
    mockCanAccessCompany.mockReset();
    mockGetUserCompanyIds.mockReset();
  });

  it("returns 403 when caller lacks member role on the company", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockCanAccessCompany.mockResolvedValue(true);
    mockRequireRole.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await GET(new Request("http://x/api/audit?companyId=c1"));
    expect(res.status).toBe(403);
  });

  it("returns 200 when caller has at least member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockCanAccessCompany.mockResolvedValue(true);
    mockRequireRole.mockResolvedValue({ ok: true, role: "admin" });
    const res = await GET(new Request("http://x/api/audit?companyId=c1"));
    expect(res.status).toBe(200);
  });
});
