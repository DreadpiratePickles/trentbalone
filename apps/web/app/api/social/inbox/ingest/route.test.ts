import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockGetCompany,
  mockIngestSocialInbox,
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
  mockGetCompany: vi.fn(),
  mockIngestSocialInbox: vi.fn(),
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

vi.mock("@/lib/store", () => ({ store: { getCompany: mockGetCompany } }));

vi.mock("@/lib/social/inbox-ingestion", () => ({ ingestSocialInbox: mockIngestSocialInbox }));

import { POST } from "./route";

describe("/api/social/inbox/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockIngestSocialInbox.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { companyId: "co_1", accounts: [], fetchedMessages: 2, importedMessages: 1, skippedDuplicates: 1 };
    });
  });

  it("requires admin access and ingests under RLS", async () => {
    const res = await POST(new Request("http://x/api/social/inbox/ingest", {
      method: "POST",
      body: JSON.stringify({ companyId: "co_1", missionRunId: "amr_1", limit: 10 }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId: "co_1" });
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockIngestSocialInbox).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      missionRunId: "amr_1",
      limit: 10,
    }));
    expect(body.result.importedMessages).toBe(1);
  });
});
