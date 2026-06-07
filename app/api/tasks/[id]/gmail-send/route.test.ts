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
    getTask: vi.fn().mockResolvedValue({ id: "t1", companyId: "c1", agentRole: "engineer", status: "queued" }),
  }
}));

vi.mock("@/lib/gmail", () => ({
  sendGmailDraftForTask: vi.fn().mockResolvedValue({ status: "success" }),
}));

import { POST } from "./route";

describe("/api/tasks/[id]/gmail-send RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("POST: returns 403 when caller lacks member role for task", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { entityType: "task", entityId: "t1" });
  });
});
