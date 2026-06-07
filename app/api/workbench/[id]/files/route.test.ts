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
    getWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws1", companyId: "c1", provider: "mock_local" }),
  }
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => ({
    listFiles: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue("content"),
    writeFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { GET, POST } from "./route";

describe("/api/workbench/[id]/files RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("POST (read): returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "read", path: "file.txt" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST (read): returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "read", path: "file.txt" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("POST (write): returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "write", path: "file.txt", content: "data" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST (write): returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "write", path: "file.txt", content: "data" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });
});
