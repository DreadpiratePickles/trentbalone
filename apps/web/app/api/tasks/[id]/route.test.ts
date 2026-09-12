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
    getTask: vi.fn().mockResolvedValue({ id: "t1", companyId: "c1" }),
    updateTask: vi.fn().mockResolvedValue({ id: "t1" }),
  }
}));

import { PATCH, POST } from "./route";

describe("/api/tasks/[id] RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("PATCH: returns 403 when caller lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = new Request("http://x/api/tasks/t1", {
      method: "PATCH",
      body: JSON.stringify({ title: "New Title" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { entityType: "task", entityId: "t1" });
  });

  it("POST: returns 403 when caller lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = new Request("http://x/api/tasks/t1", {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { entityType: "task", entityId: "t1" });
  });
});
