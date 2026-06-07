import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockListWorkbenchSessions,
  mockStartAppBuilderRun,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockListWorkbenchSessions: vi.fn(),
  mockStartAppBuilderRun: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => new Response(String(retryAfterSeconds), { status: 429 }),
}));

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
    listWorkbenchSessions: mockListWorkbenchSessions,
  },
}));

vi.mock("@/lib/app-builder/runs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-builder/runs")>();
  return { ...actual, startAppBuilderRun: mockStartAppBuilderRun };
});

import { GET, POST } from "./route";

describe("/api/app-builder/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockListWorkbenchSessions.mockResolvedValue([]);
    mockStartAppBuilderRun.mockResolvedValue({ id: "run_1", companyId: "co_1" });
  });

  it("POST enforces auth, member role, rate limit, and RLS before starting a run", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", prompt: "Build a CRM" }));

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockStartAppBuilderRun).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      prompt: "Build a CRM",
    }));
  });

  it("POST accepts daytona now that a real sandbox adapter exists", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      prompt: "Build a CRM",
      sandboxProvider: "daytona",
    }));

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockStartAppBuilderRun).toHaveBeenCalledWith(expect.objectContaining({
      sandboxProvider: "daytona",
    }));
  });

  it("GET lists only app-builder workbench runs for the company", async () => {
    mockListWorkbenchSessions.mockResolvedValue([
      { id: "ws_1", companyId: "co_1", objective: "App Builder: Build CRM", metadata: {} },
      { id: "ws_2", companyId: "co_1", objective: "Other work", metadata: {} },
    ]);

    const res = await GET(new Request("http://x/api/app-builder/runs?companyId=co_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe("ws_1");
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/app-builder/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
