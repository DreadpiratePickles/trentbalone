import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockStore,
  mockEnsureWorkbenchSandboxReady,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStore: {
    getWorkbenchSession: vi.fn(),
    listWorkbenchChatMessages: vi.fn(),
    updateWorkbenchSession: vi.fn(),
    addWorkbenchEvent: vi.fn(),
    addWorkbenchChatMessage: vi.fn(),
  },
  mockEnsureWorkbenchSandboxReady: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: (_companyId: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/workbench-orchestrator", () => ({
  ensureWorkbenchSandboxReady: mockEnsureWorkbenchSandboxReady,
}));
vi.mock("@/lib/workbench-agent", () => ({
  runWorkbenchAgent: vi.fn(),
}));

import { POST } from "./route";

describe("/api/workbench/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockStore.getWorkbenchSession.mockResolvedValue({
      id: "ws1",
      companyId: "c1",
      provider: "mock_local",
      agentRole: "engineer",
    });
    mockStore.listWorkbenchChatMessages.mockResolvedValue([]);
    mockStore.updateWorkbenchSession.mockResolvedValue(undefined);
    mockStore.addWorkbenchEvent.mockResolvedValue(undefined);
    mockStore.addWorkbenchChatMessage.mockResolvedValue(undefined);
    mockEnsureWorkbenchSandboxReady.mockResolvedValue(undefined);
  });

  it("marks the session failed and records an error when sandbox readiness fails before streaming", async () => {
    mockEnsureWorkbenchSandboxReady.mockRejectedValue(new Error("mock_local restore failed"));

    const res = await POST(new Request("http://x/api/workbench/ws1/messages", {
      method: "POST",
      body: JSON.stringify({ content: "Create trent-test-plan.md" }),
    }), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "mock_local restore failed" });
    expect(mockStore.updateWorkbenchSession).toHaveBeenCalledWith("ws1", expect.objectContaining({
      status: "failed",
      stoppedAt: expect.any(String),
    }));
    expect(mockStore.addWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "c1",
      sessionId: "ws1",
      type: "system",
      status: "failed",
      title: "Workbench message failed",
      content: expect.stringContaining("mock_local restore failed"),
    }));
    expect(mockStore.addWorkbenchChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "c1",
      sessionId: "ws1",
      role: "assistant",
      content: expect.stringContaining("mock_local restore failed"),
    }));
  });
});
