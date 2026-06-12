import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

const { mockGetWorkbenchSession, mockUpdateWorkbenchSession, mockAddWorkbenchEvent, mockEnsureReady, mockEnqueue, mockCheckout } = vi.hoisted(() => ({
  mockGetWorkbenchSession: vi.fn(),
  mockUpdateWorkbenchSession: vi.fn(),
  mockAddWorkbenchEvent: vi.fn(),
  mockEnsureReady: vi.fn(async () => { order.push("ensure"); }),
  mockEnqueue: vi.fn(async () => { order.push("enqueue"); }),
  mockCheckout: vi.fn(async () => { order.push("checkout"); }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: mockGetWorkbenchSession,
    updateWorkbenchSession: mockUpdateWorkbenchSession,
    addWorkbenchEvent: mockAddWorkbenchEvent,
  },
}));

vi.mock("@/lib/workbench-orchestrator", () => ({
  ensureWorkbenchSandboxReady: mockEnsureReady,
  enqueueWorkbenchSession: mockEnqueue,
}));

vi.mock("@/lib/git-checkout", () => ({
  checkoutRepository: mockCheckout,
}));

vi.mock("@/lib/workbench-provider", () => ({
  getWorkbenchProvider: vi.fn(() => ({ name: "mock_local" })),
}));

vi.mock("@/lib/workbench-providers", () => ({}));

import { startWorkbenchSessionAfterImports } from "@/lib/workbench-session-start";

describe("startWorkbenchSessionAfterImports", () => {
  beforeEach(() => {
    order.length = 0;
    mockGetWorkbenchSession.mockReset();
    mockUpdateWorkbenchSession.mockReset();
    mockAddWorkbenchEvent.mockReset();
    mockEnsureReady.mockClear();
    mockEnqueue.mockClear();
    mockCheckout.mockClear();
  });

  it("prepares sandbox and repo before enqueueing the agent", async () => {
    const session = {
      id: "ws_1",
      companyId: "co_1",
      provider: "mock_local",
      status: "queued",
      repoUrl: "https://github.com/example/app",
    };
    mockGetWorkbenchSession.mockResolvedValueOnce(session).mockResolvedValueOnce({ ...session, status: "running" });

    await expect(startWorkbenchSessionAfterImports("ws_1")).resolves.toMatchObject({ status: "running" });

    expect(order).toEqual(["ensure", "checkout", "enqueue"]);
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "GitHub import started" }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({ title: "GitHub import completed" }));
  });
});
