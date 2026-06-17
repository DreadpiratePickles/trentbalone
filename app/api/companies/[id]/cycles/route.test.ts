import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

const { mockCheckRateLimit, mockCheckCycleRateLimit, mockRateLimitExceeded } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockCheckCycleRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  checkCycleRateLimit: mockCheckCycleRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

const { mockGetCompany, mockGetJobRun, mockListCycles, mockListExecutions } = vi.hoisted(() => ({
  mockGetCompany: vi.fn(),
  mockGetJobRun: vi.fn(),
  mockListCycles: vi.fn().mockResolvedValue([]),
  mockListExecutions: vi.fn().mockResolvedValue([]),
}));
const { mockEnqueueCompanyCycle, mockProcessJobData, mockRemoveQueuedBullJob } = vi.hoisted(() => ({
  mockEnqueueCompanyCycle: vi.fn(),
  mockProcessJobData: vi.fn(),
  mockRemoveQueuedBullJob: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    getJobRun: mockGetJobRun,
    listCycles: mockListCycles,
    listExecutions: mockListExecutions,
  },
}));

vi.mock("@/lib/queue", () => ({
  enqueueCompanyCycle: mockEnqueueCompanyCycle,
  processJobData: mockProcessJobData,
  removeQueuedBullJob: mockRemoveQueuedBullJob,
}));

import { GET, POST } from "./route";

function makeMockRequest(urlStr: string, options?: RequestInit) {
  const req = new Request(urlStr, options) as any;
  req.nextUrl = new URL(urlStr);
  return req;
}

describe("/api/companies/[id]/cycles RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetCompany.mockReset();
    mockGetJobRun.mockReset();
    mockListCycles.mockReset();
    mockListExecutions.mockReset();
    mockEnqueueCompanyCycle.mockReset();
    mockProcessJobData.mockReset();
    mockRemoveQueuedBullJob.mockReset();
    mockCheckRateLimit.mockReset();
    mockCheckCycleRateLimit.mockReset();
    mockRateLimitExceeded.mockReset();
    // Default: rate limits pass so existing tests are unaffected
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockCheckCycleRateLimit.mockResolvedValue({ ok: true });
    mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
    mockRemoveQueuedBullJob.mockResolvedValue({ hasQueue: true, removed: true, state: "waiting" });
    mockProcessJobData.mockResolvedValue(undefined);
  });

  describe("GET", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);
      
      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks viewer role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
    });

    it("returns 200 and loads cycles if viewer role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
      mockListCycles.mockResolvedValue([{ id: "cy1", index: 1 }]);
      mockListExecutions.mockResolvedValue([]);

      const res = await GET(makeMockRequest("http://x"), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cycles).toEqual([{ id: "cy1", index: 1 }]);
    });
  });

  describe("POST", () => {
    it("returns 401 if unauthenticated", async () => {
      mockGetAuthUser.mockResolvedValue(null);
      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(401);
    });

    it("returns 404 if company does not exist", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue(null);

      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(404);
    });

    it("returns 403 if user lacks member role", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

      const res = await POST(makeMockRequest("http://x", { method: "POST" }), { params: Promise.resolve({ id: "c1" }) });
      expect(res.status).toBe(403);
      expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
    });

    it("returns 202 and queues company cycle if member role is satisfied", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockEnqueueCompanyCycle.mockResolvedValue({ id: "job_1", type: "company_scheduled_cycle", companyId: "c1" });

      const res = await POST(
        makeMockRequest("http://x", { method: "POST", body: JSON.stringify({}) }),
        { params: Promise.resolve({ id: "c1" }) }
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.job).toEqual({ id: "job_1", type: "company_scheduled_cycle", companyId: "c1" });
      expect(body.runCycle).toMatchObject({
        status: "queued",
        jobId: "job_1",
        runId: null,
      });
      expect(mockEnqueueCompanyCycle).toHaveBeenCalledWith({
        companyId: "c1",
        trigger: "user",
        cycleTrigger: "manual",
      });
    });

    it("processNow removes the queued BullMQ job and runs the persisted cycle job immediately", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockEnqueueCompanyCycle.mockResolvedValue({ id: "job_1", type: "company_scheduled_cycle", companyId: "c1" });
      mockGetJobRun.mockResolvedValue({
        id: "job_1",
        type: "company_scheduled_cycle",
        companyId: "c1",
        status: "completed",
      });

      const res = await POST(
        makeMockRequest("http://x", {
          method: "POST",
          body: JSON.stringify({ processNow: true }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.processed).toBe(true);
      expect(body.job.status).toBe("completed");
      expect(mockRemoveQueuedBullJob).toHaveBeenCalledWith("job_1");
      expect(mockProcessJobData).toHaveBeenCalledWith("company_scheduled_cycle", {
        jobRunId: "job_1",
        companyId: "c1",
        trigger: "user",
        cycleTrigger: "manual",
      });
    });

    it("processNow leaves an already-active worker job queued instead of risking duplicate execution", async () => {
      mockGetAuthUser.mockResolvedValue({ id: "u1" });
      mockGetCompany.mockResolvedValue({ id: "c1" });
      mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
      mockEnqueueCompanyCycle.mockResolvedValue({ id: "job_1", type: "company_scheduled_cycle", companyId: "c1" });
      mockRemoveQueuedBullJob.mockResolvedValue({ hasQueue: true, removed: false, state: "active" });

      const res = await POST(
        makeMockRequest("http://x", {
          method: "POST",
          body: JSON.stringify({ processNow: true }),
        }),
        { params: Promise.resolve({ id: "c1" }) }
      );

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.processing).toBe("worker_active");
      expect(mockProcessJobData).not.toHaveBeenCalled();
    });
  });
});

describe("POST /cycles rate limiting", () => {
  const params = { params: Promise.resolve({ id: "co_1" }) };

  beforeEach(() => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetCompany.mockResolvedValue({ id: "co_1", name: "Acme", status: "active" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockCheckCycleRateLimit.mockResolvedValue({ ok: true });
    mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
  });

  it("returns 429 when user/company global limit exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(new Request("http://x", { method: "POST" }), params);
    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(30);
  });

  it("returns 429 when cycle-specific limit exceeded", async () => {
    mockCheckCycleRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 1800 });
    const res = await POST(new Request("http://x", { method: "POST" }), params);
    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(1800);
  });
});
