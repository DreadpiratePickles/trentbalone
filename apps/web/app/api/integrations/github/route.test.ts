import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockSaveGitHubConnection } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockSaveGitHubConnection: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/github", () => ({
  validateGitHubConnection: vi.fn().mockResolvedValue({}),
  getGitHubCredentials: vi.fn().mockResolvedValue({}),
  listGitHubRepos: vi.fn().mockResolvedValue([]),
  saveGitHubConnection: mockSaveGitHubConnection,
  publicGitHubConnection: vi.fn().mockReturnValue({})
}));

vi.mock("@/lib/store", () => ({
  store: {
    getIntegration: vi.fn()
  }
}));

import { GET, POST } from "./route";

describe("/api/integrations/github RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockSaveGitHubConnection.mockClear();
  });

  it("GET: returns 403 when caller lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const res = await GET(new Request("http://x/api/integrations/github?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when caller lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = new Request("http://x/api/integrations/github", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", token: "tok", owner: "o", repo: "r" })
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });

  it("POST: rejects malformed connection input before persisting credentials", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    const req = new Request("http://x/api/integrations/github", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        token: "ghp_bad\nheader",
        owner: "openai",
        repo: "trent"
      })
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid GitHub connection request" });
    expect(mockSaveGitHubConnection).not.toHaveBeenCalled();
  });
});
