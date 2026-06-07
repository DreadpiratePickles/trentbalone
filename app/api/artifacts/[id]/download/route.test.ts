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

vi.mock("@/lib/store", () => ({
  store: {
    getArtifact: (...args: any[]) => mockGetArtifact(...args),
  }
}));

import { GET } from "./route";

describe("/api/artifacts/[id]/download RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetArtifact.mockReset();
  });

  it("GET: returns 404 when artifact not found", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/artifacts/art1/download"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(404);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1", title: "T", content: "C", exportFormat: "markdown" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/artifacts/art1/download"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 with artifact markdown content when user has viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetArtifact.mockResolvedValue({ id: "art1", companyId: "c1", title: "Test Artifact", content: "Hello Content", exportFormat: "markdown" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/artifacts/art1/download"), { params: Promise.resolve({ id: "art1" }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("Hello Content");
  });
});
