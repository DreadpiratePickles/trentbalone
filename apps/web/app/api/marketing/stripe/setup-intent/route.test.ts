import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockCreateOffSessionSetupIntent,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockCreateOffSessionSetupIntent: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
  },
}));

vi.mock("@/lib/marketing/stripe-billing", () => ({
  createOffSessionSetupIntent: mockCreateOffSessionSetupIntent,
}));

import { POST } from "./route";

describe("POST /api/marketing/stripe/setup-intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockCreateOffSessionSetupIntent.mockResolvedValue({ clientSecret: "seti_secret_123" });
  });

  it("requires authentication", async () => {
    mockGetAuthUser.mockResolvedValue(null);

    const res = await POST(jsonRequest({ companyId: "co_1" }));

    expect(res.status).toBe(401);
    expect(mockCreateOffSessionSetupIntent).not.toHaveBeenCalled();
  });

  it("requires an existing company", async () => {
    mockGetCompany.mockResolvedValue(null);

    const res = await POST(jsonRequest({ companyId: "co_missing" }));

    expect(res.status).toBe(404);
  });

  it("requires member role", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });

    const res = await POST(jsonRequest({ companyId: "co_1" }));

    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
  });

  it("enforces rate limits before creating the SetupIntent", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 45 });

    const res = await POST(jsonRequest({ companyId: "co_1" }));

    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(45);
    expect(mockCreateOffSessionSetupIntent).not.toHaveBeenCalled();
  });

  it("creates the SetupIntent inside RLS and returns the client secret", async () => {
    mockWithRlsContext.mockImplementationOnce(async (_companyId: string, fn: () => Promise<Response>) => {
      expect(mockGetCompany).not.toHaveBeenCalled();
      return fn();
    });

    const res = await POST(jsonRequest({ companyId: "co_1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ clientSecret: "seti_secret_123" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockCreateOffSessionSetupIntent).toHaveBeenCalledWith("co_1");
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/stripe/setup-intent", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
