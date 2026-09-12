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

vi.mock("@/lib/store", () => ({
  store: {
    listArtifacts: vi.fn().mockResolvedValue([]),
    createArtifact: vi.fn().mockResolvedValue({ id: "art1" }),
    getCompany: vi.fn().mockResolvedValue({ id: "c1", name: "Company 1", brief: { goals: "be awesome" }, metrics: { users: 10, signups: 5, revenueCents: 50000, retentionRate: 0.95 } }),
    listTasks: vi.fn().mockResolvedValue([]),
    listCycles: vi.fn().mockResolvedValue([]),
    listDocuments: vi.fn().mockResolvedValue([]),
    listReports: vi.fn().mockResolvedValue([]),
  }
}));

import { GET, POST } from "./route";

describe("/api/artifacts RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 400 when companyId is missing", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/artifacts"));
    expect(res.status).toBe(400);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/artifacts?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/artifacts", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", prompt: "Do it", type: "dashboard" }),
    }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("GET: returns 200 with list of artifacts on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/artifacts?companyId=c1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.artifacts).toBeDefined();
  });

  it("POST: returns 201 with created artifact on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/artifacts", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", prompt: "Do it", type: "dashboard" }),
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.artifact).toBeDefined();
  });
});
