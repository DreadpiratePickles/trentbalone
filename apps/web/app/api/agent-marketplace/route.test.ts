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
    listAgentEntitlements: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/agent-marketplace", () => ({
  agentMarketplaceProducts: vi.fn().mockReturnValue([]),
  catalogWithAccess: vi.fn().mockResolvedValue([]),
  findProduct: vi.fn().mockReturnValue({ id: "prod1", name: "Test Product" }),
  grantMockEntitlement: vi.fn().mockResolvedValue({ id: "ent1" }),
  revokeMockEntitlement: vi.fn().mockResolvedValue(null),
}));

import { GET, POST } from "./route";

describe("/api/agent-marketplace RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 400 when companyId is missing", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/agent-marketplace"));
    expect(res.status).toBe(400);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/agent-marketplace?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when user lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/agent-marketplace", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", productId: "prod1", action: "mock_purchase" }),
    }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });
});
