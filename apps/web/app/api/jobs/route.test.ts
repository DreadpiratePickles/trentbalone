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
    listJobRuns: vi.fn().mockResolvedValue([]),
  },
}));

import { GET } from "./route";

describe("/api/jobs RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 400 when companyId is missing", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/jobs"));
    expect(res.status).toBe(400);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/jobs?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 with job runs on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/jobs?companyId=c1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.jobRuns).toBeDefined();
  });

  it("GET: includes reconciled run cycle control for polling fallback", async () => {
    const { store } = await import("@/lib/store");
    vi.mocked(store.listJobRuns).mockResolvedValueOnce([
      {
        id: "job_1",
        type: "company_scheduled_cycle",
        status: "completed",
        companyId: "c1",
        trigger: "user",
        startedAt: "2026-06-16T10:00:00.000Z",
        completedAt: "2026-06-16T10:00:02.000Z",
        summary: "Launched durable operating cycle run_1.",
        resultCount: 1,
        metadata: {
          result: {
            run: {
              id: "run_1",
              cycleId: "cycle_1",
              status: "running",
            },
          },
        },
      },
    ]);
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });

    const res = await GET(new Request("http://x/api/jobs?companyId=c1"));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.runCycle).toMatchObject({
      status: "running",
      jobId: "job_1",
      runId: "run_1",
      cycleId: "cycle_1",
      label: "running",
    });
  });
});
