import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetWorkbenchSession,
  mockCreateApproval,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetWorkbenchSession: vi.fn(),
  mockCreateApproval: vi.fn(),
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
    getWorkbenchSession: mockGetWorkbenchSession,
    createApproval: mockCreateApproval,
  },
}));

import { POST } from "./route";

describe("POST /api/app-builder/runs/[id]/approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetWorkbenchSession.mockResolvedValue({
      id: "run_1",
      companyId: "co_1",
      objective: "App Builder: Build CRM",
      previewUrl: "https://preview.trent.app",
    });
    mockCreateApproval.mockResolvedValue({ id: "approval_1", status: "pending" });
  });

  it("creates an approval-gated PR or deploy card for an app-builder run", async () => {
    const res = await POST(
      new Request("http://x/api/app-builder/runs/run_1/approval?companyId=co_1", {
        method: "POST",
        body: JSON.stringify({ target: "deploy", estimatedCostCents: 900, rollbackTarget: "vercel:deployment_123" }),
      }),
      { params: Promise.resolve({ id: "run_1" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: "app_builder_deploy",
      previewKind: "generic",
    }));
    expect(body.card.rollbackTarget).toBe("vercel:deployment_123");
  });
});
