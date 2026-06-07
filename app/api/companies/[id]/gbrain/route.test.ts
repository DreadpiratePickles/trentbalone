import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetStatus,
  mockSaveConnection,
  mockNormalize,
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
  mockGetStatus: vi.fn(),
  mockSaveConnection: vi.fn(),
  mockNormalize: vi.fn(),
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

vi.mock("@/lib/gbrain/gbrain-connections", () => ({
  getGbrainConnectionStatus: mockGetStatus,
  saveGbrainConnection: mockSaveConnection,
  normalizeGbrainConnectionInput: mockNormalize,
}));

import { GET, POST } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1" }) };
const STATUS = { provider: "GBrain", status: "connected", source: "company", scopes: [], baseUrl: "https://co.gbrain.example", apiKey: "gb_…cret" };

describe("/api/companies/[id]/gbrain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetStatus.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return STATUS;
    });
    mockNormalize.mockImplementation((input) => ({ companyId: input.companyId, baseUrl: input.baseUrl, apiKey: input.apiKey }));
    mockSaveConnection.mockResolvedValue({});
  });

  it("GET returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/companies/co_1/gbrain"), PARAMS);
    expect(res.status).toBe(401);
  });

  it("GET returns the connection status for viewers inside RLS", async () => {
    const res = await GET(new Request("http://x/api/companies/co_1/gbrain"), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(body.connection).toEqual(STATUS);
  });

  it("POST rejects an invalid baseUrl", async () => {
    mockNormalize.mockImplementation(() => { throw new Error("baseUrl must be a valid http(s) URL"); });
    const res = await POST(new Request("http://x/api/companies/co_1/gbrain", { method: "POST", body: JSON.stringify({ baseUrl: "nope" }) }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("POST saves a connection for admins inside RLS", async () => {
    const res = await POST(new Request("http://x/api/companies/co_1/gbrain", {
      method: "POST",
      body: JSON.stringify({ baseUrl: "https://co.gbrain.example", apiKey: "gb_secret" }),
    }), PARAMS);
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockSaveConnection).toHaveBeenCalledWith("co_1", { baseUrl: "https://co.gbrain.example", apiKey: "gb_secret" });
    expect(body.connection).toEqual(STATUS);
  });
});
