import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetCompany,
  mockGetMarketingAccount,
  mockCreateAdCampaign,
  mockGetMarketingPlatformAdapter,
  mockCreateCampaignDraft,
  rlsState,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
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
  mockGetMarketingAccount: vi.fn(),
  mockCreateAdCampaign: vi.fn(),
  mockGetMarketingPlatformAdapter: vi.fn(),
  mockCreateCampaignDraft: vi.fn(),
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
    getMarketingAccount: mockGetMarketingAccount,
    createAdCampaign: mockCreateAdCampaign,
  },
}));

vi.mock("@/lib/marketing/platform-adapter", () => ({
  getMarketingPlatformAdapter: mockGetMarketingPlatformAdapter,
  isMarketingPlatform: (value: unknown) =>
    typeof value === "string" && ["meta", "google", "tiktok", "linkedin", "reddit"].includes(value),
}));

import { POST } from "./route";

describe("POST /api/marketing/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetCompany.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return { id: "co_1" };
    });
    mockGetMarketingAccount.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return {
        id: "ma_1",
        companyId: "co_1",
        platform: "meta",
        externalAccountId: "act_123",
      };
    });
    mockCreateCampaignDraft.mockResolvedValue({
      platform: "meta",
      externalCampaignId: "sandbox_meta_campaign_co_1_ma_1_launch_alpha",
      status: "draft",
    });
    mockGetMarketingPlatformAdapter.mockReturnValue({
      platform: "meta",
      createCampaignDraft: mockCreateCampaignDraft,
    });
    mockCreateAdCampaign.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return {
      id: "camp_1",
      companyId: "co_1",
      marketingAccountId: "ma_1",
      platform: "meta",
      externalCampaignId: "sandbox_meta_campaign_co_1_ma_1_launch_alpha",
      name: "Launch Alpha",
      objective: "LEADS",
      status: "draft",
      dailyBudgetCents: 2500,
      };
    });
  });

  it("requires auth", async () => {
    mockGetAuthUser.mockResolvedValue(null);

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(401);
  });

  it("validates required campaign draft fields", async () => {
    const res = await POST(jsonRequest({ companyId: "co_1", marketingAccountId: "ma_1" }));

    expect(res.status).toBe(400);
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
  });

  it("uses Task 2's companyId plus platform account lookup and verifies the submitted account id", async () => {
    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(200);
    expect(mockGetMarketingAccount).toHaveBeenCalledWith("co_1", "meta");
    expect(mockCreateCampaignDraft).toHaveBeenCalledWith(expect.objectContaining({
      marketingAccountId: "ma_1",
    }));
  });

  it("rejects when the platform-keyed account does not match the submitted marketingAccountId", async () => {
    mockGetMarketingAccount.mockImplementation(async () => ({
      id: "ma_other",
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "act_123",
    }));

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(404);
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
  });

  it("returns 400 when a valid platform has no implemented adapter", async () => {
    mockGetMarketingAccount.mockImplementation(async () => ({
      id: "ma_1",
      companyId: "co_1",
      platform: "google",
      externalAccountId: "google_123",
    }));
    mockGetMarketingPlatformAdapter.mockImplementationOnce(() => {
      throw new Error("Marketing platform adapter not implemented: google");
    });

    const res = await POST(jsonRequest({ ...validBody(), platform: "google" }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Marketing platform adapter not implemented: google");
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
    expect(mockCreateAdCampaign).not.toHaveBeenCalled();
  });

  it("rejects accounts without an external provider account id", async () => {
    mockGetMarketingAccount.mockImplementation(async () => ({
      id: "ma_1",
      companyId: "co_1",
      platform: "meta",
      externalAccountId: null,
    }));

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(400);
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
  });

  it("rejects accounts with blank external provider account ids before adapter calls", async () => {
    mockGetMarketingAccount.mockImplementation(async () => ({
      id: "ma_1",
      companyId: "co_1",
      platform: "meta",
      externalAccountId: "   ",
    }));

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(400);
    expect(mockGetMarketingPlatformAdapter).not.toHaveBeenCalled();
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
  });

  it("requires member role for the company", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
  });

  it("applies rate limiting before creating a draft", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 45 });

    const res = await POST(jsonRequest(validBody()));

    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(45);
    expect(mockCreateCampaignDraft).not.toHaveBeenCalled();
  });

  it("creates a Trent campaign row and platform draft inside RLS without launching spend", async () => {
    const res = await POST(jsonRequest(validBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetMarketingAccount).toHaveBeenCalledWith("co_1", "meta");
    expect(mockCreateCampaignDraft).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      externalAccountId: "act_123",
      name: "Launch Alpha",
      objective: "LEADS",
      dailyBudgetCents: 2500,
    }));
    expect(mockCreateAdCampaign).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      marketingAccountId: "ma_1",
      platform: "meta",
      externalCampaignId: "sandbox_meta_campaign_co_1_ma_1_launch_alpha",
      status: "draft",
      dailyBudgetCents: 2500,
    }));
    expect(body.campaign.status).toBe("draft");
  });

  it("wraps tenant company and campaign store access in RLS", async () => {
    await POST(jsonRequest(validBody()));

    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetCompany).toHaveBeenCalledTimes(1);
    expect(mockGetMarketingAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateAdCampaign).toHaveBeenCalledTimes(1);
  });
});

function validBody() {
  return {
    companyId: "co_1",
    marketingAccountId: "ma_1",
    platform: "meta",
    name: "Launch Alpha",
    objective: "LEADS",
    dailyBudgetCents: 2500,
  };
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/campaigns", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
