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

vi.mock("@/lib/store", () => ({
  store: {
    listIntegrations: vi.fn().mockResolvedValue([]),
    revokeIntegration: vi.fn(),
    addAudit: vi.fn()
  }
}));

import { GET, POST, DELETE } from "./route";

describe("/api/integrations RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 403 when caller lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await GET(new Request("http://x/api/integrations?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = new Request("http://x/api/integrations", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1" })
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });

  it("POST: returns not configured instead of mocked success for generic connectors", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    const req = new Request("http://x/api/integrations", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1" })
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(501);
    expect(body.status).toBe("not_configured");
    expect(body.message).not.toMatch(/mock/i);
  });

  it("DELETE: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await DELETE(new Request("http://x/api/integrations?companyId=c1&provider=GitHub"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });
});
