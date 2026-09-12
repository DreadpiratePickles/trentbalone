import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCheckRateLimit, mockWithRlsContext, mockStore } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockStore: { getCompany: vi.fn(), updateCompany: vi.fn(), addAudit: vi.fn() },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/store", () => ({ store: mockStore }));

import { GET, PATCH } from "./route";

describe("/api/companies/[id]/control-plane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockStore.getCompany.mockResolvedValue({ id: "co_1", brief: {}, budgetCents: 1000 });
    mockStore.updateCompany.mockResolvedValue({ id: "co_1" });
    mockStore.addAudit.mockResolvedValue({});
  });

  it("GET returns safe descriptors behind auth, RBAC, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/control-plane"), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.controlPlane.secrets.rendersSecretValues).toBe(false);
  });

  it("PATCH rejects raw secret values and audits accepted policy updates", async () => {
    const rejected = await PATCH(new Request("http://x/api/companies/co_1/control-plane", {
      method: "PATCH",
      body: JSON.stringify({ section: "secrets", value: "raw-secret" }),
    }), { params: Promise.resolve({ id: "co_1" }) });
    expect(rejected.status).toBe(400);

    const accepted = await PATCH(new Request("http://x/api/companies/co_1/control-plane", {
      method: "PATCH",
      body: JSON.stringify({ section: "models", modelTierByRole: { engineer: "sonnet" } }),
    }), { params: Promise.resolve({ id: "co_1" }) });

    expect(accepted.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockStore.updateCompany).toHaveBeenCalledWith("co_1", {
      brief: expect.objectContaining({
        modelTierByRole: { engineer: "sonnet" },
      }),
    });
    expect(mockStore.addAudit).toHaveBeenCalledWith(
      "co_1",
      "user",
      "control_plane.update",
      "settings",
      "co_1",
      "Updated models control-plane settings"
    );
  });
});
