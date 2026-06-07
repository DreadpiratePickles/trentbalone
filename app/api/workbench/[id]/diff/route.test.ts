import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockGetWorkbenchCheckpoint, mockDiffSinceCheckpoint } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockGetWorkbenchCheckpoint: vi.fn(),
  mockDiffSinceCheckpoint: vi.fn(),
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
    getWorkbenchCheckpoint: mockGetWorkbenchCheckpoint,
  }
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => ({
    diffSinceCheckpoint: mockDiffSinceCheckpoint,
  }),
}));

import { GET } from "./route";

describe("/api/workbench/[id]/diff RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetWorkbenchCheckpoint.mockReset();
    mockDiffSinceCheckpoint.mockReset();
    mockGetWorkbenchCheckpoint.mockResolvedValue({ fileTreeHash: "oldhash" });
    mockDiffSinceCheckpoint.mockResolvedValue({ changedPaths: ["src/App.tsx"], summary: "1 file changed", fromHash: "oldhash", toHash: "newhash" });
  });

  it("returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });

    const res = await GET(new Request("http://x/api/workbench/ws1/diff"), { params: Promise.resolve({ id: "ws1" }) });

    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("returns provider diff from the persisted checkpoint hash", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

    const res = await GET(new Request("http://x/api/workbench/ws1/diff"), { params: Promise.resolve({ id: "ws1" }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockDiffSinceCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ id: "ws1" }), "oldhash");
    expect(json.diff.changedPaths).toEqual(["src/App.tsx"]);
  });
});
