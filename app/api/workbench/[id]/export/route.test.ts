import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockExportArtifacts } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockExportArtifacts: vi.fn(),
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
  },
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => ({
    exportArtifacts: mockExportArtifacts,
  }),
}));

import { POST } from "./route";

describe("/api/workbench/[id]/export", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockExportArtifacts.mockReset();
    mockExportArtifacts.mockResolvedValue({
      artifact: { id: "art_export", kind: "export", title: "Export bundle" },
      event: { id: "evt_export", type: "artifact", title: "Exported artifacts" },
    });
  });

  it("requires member access because export creates a persisted artifact", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });

    const res = await POST(new Request("http://x/api/workbench/ws1/export", { method: "POST" }), {
      params: Promise.resolve({ id: "ws1" }),
    });

    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("returns the provider export artifact and event", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench/ws1/export", { method: "POST" }), {
      params: Promise.resolve({ id: "ws1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockExportArtifacts).toHaveBeenCalledWith(expect.objectContaining({ id: "ws1" }));
    expect(json.artifact.id).toBe("art_export");
    expect(json.event.id).toBe("evt_export");
  });
});
