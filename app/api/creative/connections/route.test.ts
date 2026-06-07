import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockNormalizeCreativeConnectionInput,
  mockListCreativeConnectionStatuses,
  mockSaveCreativeConnection,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockGetCompany: vi.fn(),
  mockNormalizeCreativeConnectionInput: vi.fn((input: Record<string, unknown>) => {
    if (input.app !== "higgsfield" && input.app !== "hyperframes" && input.app !== "open_generative_ai") {
      throw new Error("app must be one of higgsfield, hyperframes, open_generative_ai");
    }
    return { companyId: String(input.companyId), app: input.app, apiKey: String(input.apiKey) };
  }),
  mockListCreativeConnectionStatuses: vi.fn(),
  mockSaveCreativeConnection: vi.fn(),
}));

let insideRls = false;
const getCompanyInsideRlsCalls: boolean[] = [];

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
  store: { getCompany: mockGetCompany },
}));

vi.mock("@/lib/creative-connections", () => ({
  normalizeCreativeConnectionInput: mockNormalizeCreativeConnectionInput,
  listCreativeConnectionStatuses: mockListCreativeConnectionStatuses,
  saveCreativeConnection: mockSaveCreativeConnection,
}));

import { GET, POST } from "./route";

describe("/api/creative/connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insideRls = false;
    getCompanyInsideRlsCalls.length = 0;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<Response>) => {
      insideRls = true;
      try {
        return await fn();
      } finally {
        insideRls = false;
      }
    });
    mockGetCompany.mockImplementation(async () => {
      getCompanyInsideRlsCalls.push(insideRls);
      return { id: "co_1" };
    });
    mockListCreativeConnectionStatuses.mockResolvedValue([
      { app: "higgsfield", provider: "Higgsfield", status: "connected", source: "company", apiKey: "higg...6789", scopes: ["creative:generate"] },
    ]);
    mockSaveCreativeConnection.mockResolvedValue({
      id: "connection_1",
      companyId: "co_1",
      provider: "Higgsfield",
      scopes: ["creative:generate"],
      status: "connected",
      lastCheckedAt: "2026-06-04T00:00:00.000Z",
    });
  });

  it("GET returns creative connection statuses with viewer auth, rate limit, and RLS", async () => {
    const res = await GET(new Request("http://x/api/creative/connections?companyId=co_1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
    expect(mockCheckRateLimit).toHaveBeenCalledWith("user_1", "co_1");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockListCreativeConnectionStatuses).toHaveBeenCalledWith("co_1");
    expect(body.connections[0].apiKey).toBe("higg...6789");
    expect(getCompanyInsideRlsCalls).toEqual([true]);
  });

  it("POST saves a creative credential with admin auth and never echoes the raw api key", async () => {
    const res = await POST(jsonRequest({
      companyId: "co_1",
      app: "higgsfield",
      apiKey: "higgs_live_123456789",
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockSaveCreativeConnection).toHaveBeenCalledWith("co_1", {
      app: "higgsfield",
      apiKey: "higgs_live_123456789",
    });
    expect(JSON.stringify(body)).not.toContain("higgs_live_123456789");
    expect(body.connection.provider).toBe("Higgsfield");
  });

  it("rejects invalid creative apps before entering RLS", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", app: "unknown", apiKey: "secret" }));

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
    expect(mockSaveCreativeConnection).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/creative/connections", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
