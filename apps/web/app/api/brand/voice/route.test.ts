import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockGetVoiceProfile,
  mockDeriveVoiceProfile,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockGetVoiceProfile: vi.fn(),
  mockDeriveVoiceProfile: vi.fn(),
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

vi.mock("@/lib/brand/voice-memory", () => ({
  getVoiceProfile: mockGetVoiceProfile,
  deriveVoiceProfile: mockDeriveVoiceProfile,
}));

import { GET, POST } from "./route";

describe("/api/brand/voice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockResolvedValue({ id: "co_1" });
    mockGetVoiceProfile.mockResolvedValue({ toneMarkers: ["direct"], confidence: "low" });
    mockDeriveVoiceProfile.mockResolvedValue({ toneMarkers: ["direct"], confidence: "low" });
  });

  it("GET requires viewer role and runs inside RLS", async () => {
    const res = await GET(new Request("http://x/api/brand/voice?companyId=co_1"));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetVoiceProfile).toHaveBeenCalledWith("co_1");
  });

  it("POST requires member role and derives from samples", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", samples: ["One", "Two"] }));

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
    expect(mockDeriveVoiceProfile).toHaveBeenCalledWith("co_1", ["One", "Two"]);
  });

  it("POST validates samples", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", samples: [] }));
    expect(res.status).toBe(400);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/brand/voice", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
