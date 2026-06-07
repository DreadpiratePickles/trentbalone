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
    getWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws1", companyId: "c1", provider: "mock_local" }),
  }
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => ({
    screenshot: vi.fn().mockResolvedValue({ storageKey: "sk1", width: 100, height: 100 }),
  }),
}));

import { POST } from "./route";

describe("/api/workbench/[id]/screenshot RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/screenshot", {
      method: "POST",
      body: JSON.stringify({ url: "http://example.com" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/workbench/ws1/screenshot", {
      method: "POST",
      body: JSON.stringify({ url: "http://example.com" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });
});
