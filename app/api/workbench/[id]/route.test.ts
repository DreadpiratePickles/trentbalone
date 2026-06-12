import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthUser,
  mockRecordAppSoloHeartbeat,
  mockRequireRoleForRequest,
  mockResumeAppSoloWorkbenchSession,
  mockStopWorkbenchSession,
  mockStore,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRecordAppSoloHeartbeat: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockResumeAppSoloWorkbenchSession: vi.fn(),
  mockStopWorkbenchSession: vi.fn(),
  mockStore: {
    getWorkbenchSession: vi.fn(),
    updateWorkbenchSession: vi.fn(),
    deleteWorkbenchSession: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    addWorkbenchEvent: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: mockStore
}));

vi.mock("@/lib/workbench-orchestrator", () => ({
  recordAppSoloHeartbeat: mockRecordAppSoloHeartbeat,
  resumeAppSoloWorkbenchSession: mockResumeAppSoloWorkbenchSession,
  stopWorkbenchSession: mockStopWorkbenchSession
}));

import { DELETE, GET, PATCH } from "./route";

describe("/api/workbench/[id] RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRecordAppSoloHeartbeat.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockResumeAppSoloWorkbenchSession.mockReset();
    mockStopWorkbenchSession.mockReset();
    mockStore.getWorkbenchSession.mockReset();
    mockStore.updateWorkbenchSession.mockReset();
    mockStore.deleteWorkbenchSession.mockReset();
    mockStore.listWorkbenchEvents.mockReset();
    mockStore.listWorkbenchArtifacts.mockReset();
    mockStore.addWorkbenchEvent.mockReset();
    mockStore.getWorkbenchSession.mockResolvedValue({ id: "ws1", companyId: "c1", status: "running", objective: "Old name", stoppedAt: undefined });
    mockStore.updateWorkbenchSession.mockResolvedValue({ id: "ws1", companyId: "c1", objective: "New name" });
    mockStore.deleteWorkbenchSession.mockResolvedValue(true);
    mockStore.listWorkbenchEvents.mockResolvedValue([]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);
    mockStore.addWorkbenchEvent.mockResolvedValue({});
    mockRecordAppSoloHeartbeat.mockResolvedValue({ id: "ws1", companyId: "c1", status: "running", objective: "Old name" });
    mockResumeAppSoloWorkbenchSession.mockResolvedValue({ id: "ws1", companyId: "c1", status: "running", objective: "Old name" });
    mockStopWorkbenchSession.mockResolvedValue(undefined);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/workbench/ws1"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/workbench/ws1"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("PATCH: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("PATCH: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ status: "completed" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("PATCH: cancels through the workbench orchestrator so provider sandboxes stop", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockStore.getWorkbenchSession
      .mockResolvedValueOnce({ id: "ws1", companyId: "c1", status: "running", objective: "Old name", stoppedAt: undefined })
      .mockResolvedValueOnce({ id: "ws1", companyId: "c1", status: "cancelled", objective: "Old name", stoppedAt: "2026-06-05T12:00:00.000Z" });

    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockStopWorkbenchSession).toHaveBeenCalledWith("ws1", "cancelled");
    expect(mockStore.updateWorkbenchSession).not.toHaveBeenCalled();
    expect(mockStore.addWorkbenchEvent).not.toHaveBeenCalled();
    expect(body.session.status).toBe("cancelled");
  });

  it("PATCH: records an app-solo heartbeat through the orchestrator", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ action: "app_solo_heartbeat" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRecordAppSoloHeartbeat).toHaveBeenCalledWith("ws1");
    expect(mockStore.updateWorkbenchSession).not.toHaveBeenCalled();
    expect(body.session.status).toBe("running");
  });

  it("PATCH: resumes a paused app-solo session through the orchestrator", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ action: "app_solo_resume" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockResumeAppSoloWorkbenchSession).toHaveBeenCalledWith("ws1");
    expect(mockStore.updateWorkbenchSession).not.toHaveBeenCalled();
    expect(body.session.status).toBe("running");
  });

  it("PATCH: renames a session objective inline and records a system event", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await PATCH(new Request("http://x/api/workbench/ws1", {
      method: "PATCH",
      body: JSON.stringify({ objective: "New name" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(200);
    expect(mockStore.updateWorkbenchSession).toHaveBeenCalledWith("ws1", expect.objectContaining({ objective: "New name" }));
    expect(mockStore.addWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "system",
      title: "Session renamed",
    }));
  });

  it("DELETE: deletes a workbench session when user has member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await DELETE(new Request("http://x/api/workbench/ws1", {
      method: "DELETE",
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
    expect(mockStore.deleteWorkbenchSession).toHaveBeenCalledWith("ws1");
  });

  it("DELETE: stops a running provider sandbox before deleting the session", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await DELETE(new Request("http://x/api/workbench/ws1", {
      method: "DELETE",
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(200);
    expect(mockStopWorkbenchSession).toHaveBeenCalledWith("ws1", "cancelled");
    expect(mockStore.deleteWorkbenchSession).toHaveBeenCalledWith("ws1");
  });
});
