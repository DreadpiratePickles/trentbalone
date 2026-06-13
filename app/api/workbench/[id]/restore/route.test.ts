import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockRestore, mockAddEvent, providerHolder } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockRestore: vi.fn(),
  mockAddEvent: vi.fn().mockResolvedValue(undefined),
  providerHolder: { hasCapability: true },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws1", companyId: "c1", status: "running", provider: "mock_local" }),
    addWorkbenchEvent: mockAddEvent,
  },
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: (_companyId: string, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => (providerHolder.hasCapability
    ? { restoreWorkspaceCheckpoint: mockRestore }
    : {}),
}));

import { POST } from "./route";

function post(body: unknown) {
  return POST(new Request("http://x/api/workbench/ws1/restore", {
    method: "POST",
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "ws1" }) });
}

describe("/api/workbench/[id]/restore", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset().mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockReset().mockResolvedValue({ ok: true, role: "member" });
    mockRestore.mockReset().mockResolvedValue({ restored: true });
    mockAddEvent.mockClear();
    providerHolder.hasCapability = true;
  });

  it("returns 403 when the user lacks the member role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    expect((await post({ checkpointId: "wcp_1" })).status).toBe(403);
  });

  it("requires a checkpointId", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("409s honestly when the provider lacks the checkpoint capability", async () => {
    providerHolder.hasCapability = false;
    const res = await post({ checkpointId: "wcp_1" });
    expect(res.status).toBe(409);
  });

  it("restores via the provider and records a workbench event", async () => {
    const res = await post({ checkpointId: "wcp_best" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ restored: true, checkpointId: "wcp_best" });
    expect(mockRestore).toHaveBeenCalledWith(expect.objectContaining({ id: "ws1" }), "wcp_best");
    expect(mockAddEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", title: "Workspace restored from checkpoint" }));
  });

  it("404s with the provider's detail when the checkpoint is gone", async () => {
    mockRestore.mockResolvedValue({ restored: false, detail: "checkpoint wcp_old not found" });
    const res = await post({ checkpointId: "wcp_old" });
    expect(res.status).toBe(404);
    expect(mockAddEvent).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
