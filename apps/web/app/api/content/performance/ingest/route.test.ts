import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockQueue,
  mockExecute,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  rlsState: { active: false },
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => {
    rlsState.active = true;
    try {
      return await fn();
    } finally {
      rlsState.active = false;
    }
  }),
  mockGetCompany: vi.fn(),
  mockQueue: vi.fn(),
  mockExecute: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: () => new Response("rate limited", { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

vi.mock("@/lib/store", () => ({ store: { getCompany: mockGetCompany } }));

vi.mock("@/lib/content/performance-feedback", () => ({
  queueContentPerformanceFeedbackIngestion: mockQueue,
  executeContentPerformanceFeedbackJob: mockExecute,
}));

import { POST } from "./route";

describe("/api/content/performance/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockQueue.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "job_1", type: "content_performance_ingest", status: "running" };
    });
    mockExecute.mockResolvedValue({ status: "completed", jobRun: { id: "job_1" }, result: { status: "completed" } });
  });

  it("queues performance ingestion under admin auth and RLS", async () => {
    const res = await POST(new Request("http://x/api/content/performance/ingest", {
      method: "POST",
      body: JSON.stringify({ companyId: "co_1", missionRunId: "amr_1" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockQueue).toHaveBeenCalledWith(expect.objectContaining({ companyId: "co_1", missionRunId: "amr_1" }));
    expect(body.job.id).toBe("job_1");
  });

  it("can run the queued job immediately for cron or manual backfills", async () => {
    const res = await POST(new Request("http://x/api/content/performance/ingest", {
      method: "POST",
      body: JSON.stringify({ companyId: "co_1", runNow: true }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith("job_1");
    expect(body.execution.status).toBe("completed");
  });
});
