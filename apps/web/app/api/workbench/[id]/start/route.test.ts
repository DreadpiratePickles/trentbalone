import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockStartWorkbenchSession } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStartWorkbenchSession: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws_1", companyId: "c1", status: "queued" }),
  },
}));

vi.mock("@/lib/workbench-session-start", () => ({
  startWorkbenchSessionAfterImports: mockStartWorkbenchSession,
}));

import { POST } from "./route";

describe("POST /api/workbench/[id]/start", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockStartWorkbenchSession.mockReset();
  });

  it("starts a queued session after imports are prepared", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockStartWorkbenchSession.mockResolvedValue({ id: "ws_1", status: "running" });

    const res = await POST(new Request("http://x/api/workbench/ws_1/start", { method: "POST" }), {
      params: Promise.resolve({ id: "ws_1" }),
    });

    expect(res.status).toBe(200);
    expect(mockStartWorkbenchSession).toHaveBeenCalledWith("ws_1");
    await expect(res.json()).resolves.toMatchObject({ session: { id: "ws_1", status: "running" } });
  });
});
