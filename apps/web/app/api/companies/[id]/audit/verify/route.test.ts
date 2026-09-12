import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRole, mockForbidden, mockUnauthorized } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRole: vi.fn(),
  mockForbidden: vi.fn(() => new Response("f", { status: 403 })),
  mockUnauthorized: vi.fn(() => new Response("u", { status: 401 })),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRole: mockRequireRole,
  forbidden: mockForbidden,
  unauthorized: mockUnauthorized,
}));

const { mockVerifyAuditChain } = vi.hoisted(() => ({
  mockVerifyAuditChain: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({
  verifyAuditChain: mockVerifyAuditChain,
}));

import { GET } from "./route";

describe("GET /api/companies/[id]/audit/verify", () => {
  const params = Promise.resolve({ id: "co1" });

  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRole.mockReset();
    mockForbidden.mockReturnValue(new Response("f", { status: 403 }));
    mockUnauthorized.mockReturnValue(new Response("u", { status: 401 }));
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/companies/co1/audit/verify"), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 when user lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/companies/co1/audit/verify"), { params });
    expect(res.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith("u1", "co1", "admin");
  });

  it("returns 200 with valid=true result", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: true, role: "admin" });
    mockVerifyAuditChain.mockResolvedValue({ valid: true, count: 42 });
    const res = await GET(new Request("http://x/api/companies/co1/audit/verify"), { params });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean; count: number };
    expect(body.valid).toBe(true);
    expect(body.count).toBe(42);
    expect(mockVerifyAuditChain).toHaveBeenCalledWith("co1");
  });

  it("returns 200 with valid=false and brokenAt when chain is tampered", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: true, role: "admin" });
    mockVerifyAuditChain.mockResolvedValue({ valid: false, count: 3, brokenAt: "audit-xyz" });
    const res = await GET(new Request("http://x/api/companies/co1/audit/verify"), { params });
    expect(res.status).toBe(200);
    const body = await res.json() as { valid: boolean; count: number; brokenAt?: string };
    expect(body.valid).toBe(false);
    expect(body.brokenAt).toBe("audit-xyz");
  });
});
