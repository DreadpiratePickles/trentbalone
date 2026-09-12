import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockGetVisualProfile,
  mockSetVisualProfile,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockGetVisualProfile: vi.fn(),
  mockSetVisualProfile: vi.fn(),
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

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

vi.mock("@/lib/store", () => ({
  store: {
    getCompany: mockGetCompany,
  },
}));

vi.mock("@/lib/brand/visual-memory", () => ({
  getVisualProfile: mockGetVisualProfile,
  setVisualProfile: mockSetVisualProfile,
}));

import { GET, POST } from "./route";

describe("/api/brand/visual", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockGetVisualProfile.mockResolvedValue({ palette: ["#111111"], updatedAt: "2026-01-01T00:00:00Z" });
    mockSetVisualProfile.mockResolvedValue({ palette: ["#111111"], updatedAt: "2026-01-01T00:00:00Z" });
  });

  it("GET requires viewer role and runs inside RLS", async () => {
    const res = await GET(new Request("http://x/api/brand/visual?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetVisualProfile).toHaveBeenCalledWith("co_1");
  });

  it("POST requires member role and stores a full visual profile", async () => {
    const body = {
      companyId: "co_1",
      palette: ["#111111"],
      typography: ["Inter"],
      referenceImageUrls: [],
      negativeTerms: ["off-brand"],
    };
    const res = await POST(jsonRequest(body));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockSetVisualProfile).toHaveBeenCalledWith("co_1", expect.objectContaining({
      palette: ["#111111"],
      typography: ["Inter"],
      negativeTerms: ["off-brand"],
    }));
  });

  it("POST validates array fields", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", palette: "#111111" }));
    expect(res.status).toBe(400);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/brand/visual", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
