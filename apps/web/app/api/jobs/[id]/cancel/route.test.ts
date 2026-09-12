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
    getJobRun: vi.fn().mockResolvedValue({ id: "job1", companyId: "c1" }),
  },
}));

vi.mock("@/lib/queue", () => ({
  cancelJobRun: vi.fn().mockResolvedValue({ id: "job1", companyId: "c1", status: "cancelled" }),
}));

import { POST } from "./route";

describe("/api/jobs/[id]/cancel RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("POST: returns 404 when job is not found", async () => {
    const { store } = await import("@/lib/store");
    vi.mocked(store.getJobRun).mockResolvedValueOnce(undefined);
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await POST(
      new Request("http://x/api/jobs/job1/cancel", { method: "POST" }),
      { params: Promise.resolve({ id: "job1" }) }
    );
    expect(res.status).toBe(404);
  });

  it("POST: returns 403 when user lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(
      new Request("http://x/api/jobs/job1/cancel", { method: "POST" }),
      { params: Promise.resolve({ id: "job1" }) }
    );
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });

  it("POST: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    const res = await POST(
      new Request("http://x/api/jobs/job1/cancel", { method: "POST" }),
      { params: Promise.resolve({ id: "job1" }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobRun).toBeDefined();
  });
});
