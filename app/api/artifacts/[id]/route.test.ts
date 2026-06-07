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

const mockGetArtifact = vi.fn();
const mockUpdateArtifact = vi.fn();

vi.mock("@/lib/store", () => ({
  store: {
    getArtifact: (...args: any[]) => mockGetArtifact(...args),
    updateArtifact: (...args: any[]) => mockUpdateArtifact(...args),
  }
}));

import { GET, PATCH } from "./route";

describe("/api/artifacts/[id] RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetArtifact.mockReset();
    mockUpdateArtifact.mockReset();
  });

  it("GET: returns 404 when artifact not found", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/artifacts/art1"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(404);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/artifacts/art1"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 when user has viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/artifacts/art1"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact).toBeDefined();
  });

  it("PATCH: returns 404 when artifact not found", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue(null);
    const res = await PATCH(new Request("http://x/api/artifacts/art1", {
      method: "PATCH",
      body: JSON.stringify({ title: "New Title" })
    }), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(404);
  });

  it("PATCH: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await PATCH(new Request("http://x/api/artifacts/art1", {
      method: "PATCH",
      body: JSON.stringify({ title: "New Title" })
    }), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("PATCH: returns 200 with updated artifact when user has member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1", approvalStatus: "pending" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockUpdateArtifact.mockResolvedValue({ id: "art1", title: "New Title" });
    const res = await PATCH(new Request("http://x/api/artifacts/art1", {
      method: "PATCH",
      body: JSON.stringify({ title: "New Title" })
    }), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifact).toBeDefined();
  });
});
