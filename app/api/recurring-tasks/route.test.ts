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
    listRecurringTasks: vi.fn().mockResolvedValue([]),
    createRecurringTask: vi.fn().mockResolvedValue({ id: "rt1" }),
    getRecurringTask: vi.fn().mockResolvedValue({ id: "rt1", companyId: "c1" }),
    updateRecurringTask: vi.fn().mockResolvedValue({ id: "rt1" }),
    deleteRecurringTask: vi.fn(),
    getTask: vi.fn().mockResolvedValue({ id: "t1", companyId: "c1" }),
  }
}));

import { GET, POST, PATCH, DELETE } from "./route";

describe("/api/recurring-tasks RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 403 when caller lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = { nextUrl: { searchParams: { get: () => "c1" } } } as any;
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = {
      json: async () => ({ companyId: "c1", title: "Rt 1", prompt: "recurring prompt", agentRole: "engineer" })
    } as any;
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });

  it("PATCH: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = {
      json: async () => ({ id: "rt1", enabled: false })
    } as any;
    const res = await PATCH(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { entityType: "recurring-task", entityId: "rt1" });
  });

  it("DELETE: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = { nextUrl: { searchParams: { get: () => "rt1" } } } as any;
    const res = await DELETE(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { entityType: "recurring-task", entityId: "rt1" });
  });
});
