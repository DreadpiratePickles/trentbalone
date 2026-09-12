import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
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

import { POST } from "./route";

describe("POST /api/agent-plug/run", () => {
  beforeEach(() => {
    globalThis.__trentState = undefined;
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
  });

  it("runs a selected plug through the execution runner behind RLS", async () => {
    const response = await POST(new Request("http://x/api/agent-plug/run", {
      method: "POST",
      body: JSON.stringify({
        companyId: "company_trent_demo",
        slug: "weekly-ops-review",
        objective: "Prepare the weekly CEO review.",
        variables: { company: "Trent Demo Company" },
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "company_trent_demo" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(body.result).toMatchObject({
      status: "completed",
      plug: { slug: "weekly-ops-review" },
      launch: { ready: true },
    });
    expect(body.result.toolCalls.some((call: { toolId: string; action: string }) => call.toolId === "reports" && call.action === "create")).toBe(true);
  });

  it("rejects hidden or unknown plugs", async () => {
    const response = await POST(new Request("http://x/api/agent-plug/run", {
      method: "POST",
      body: JSON.stringify({
        companyId: "company_trent_demo",
        slug: "not-a-real-plug",
        objective: "Run this.",
      }),
    }));

    expect(response.status).toBe(404);
  });
});
