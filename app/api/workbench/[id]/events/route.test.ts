import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockStore, mockEnqueueWikiIndexRefresh } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStore: {
    getWorkbenchSession: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    addWorkbenchEvent: vi.fn(),
  },
  mockEnqueueWikiIndexRefresh: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));
vi.mock("@/lib/queue", () => ({ enqueueWikiIndexRefresh: mockEnqueueWikiIndexRefresh }));

import { GET, POST } from "./route";

describe("/api/workbench/[id]/events RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getWorkbenchSession.mockResolvedValue({ id: "ws1", companyId: "c1" });
    mockStore.listWorkbenchEvents.mockResolvedValue([]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);
    mockStore.addWorkbenchEvent.mockImplementation(async (input) => ({ id: "evt1", createdAt: "2026-05-29T00:00:00.000Z", ...input }));
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/workbench/ws1/events"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/workbench/ws1/events"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/events", {
      method: "POST",
      body: JSON.stringify({ type: "plan", status: "pending", title: "T", content: "C" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: returns 201 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/workbench/ws1/events", {
      method: "POST",
      body: JSON.stringify({ type: "plan", status: "pending", title: "T", content: "C" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(201);
  });

  it("POST: enqueues a wiki refresh after completed file events", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockEnqueueWikiIndexRefresh.mockResolvedValue({ id: "job1" });

    const res = await POST(new Request("http://x/api/workbench/ws1/events", {
      method: "POST",
      body: JSON.stringify({ type: "file", status: "completed", title: "File", content: "Changed app/page.tsx" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(201);
    expect(mockEnqueueWikiIndexRefresh).toHaveBeenCalledWith("c1", "system", "ws1");
  });

  it("POST: does not enqueue wiki refresh for ordinary plan events", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench/ws1/events", {
      method: "POST",
      body: JSON.stringify({ type: "plan", status: "completed", title: "Plan", content: "No file changed" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(201);
    expect(mockEnqueueWikiIndexRefresh).not.toHaveBeenCalled();
  });
});
