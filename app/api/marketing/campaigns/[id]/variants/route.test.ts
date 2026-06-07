import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockRateLimitExceeded,
  mockWithRlsContext,
  mockGetAdCampaign,
  mockGetMarketingAccount,
  mockCreateAdCreativeVariant,
  mockGenerateCreativeVariants,
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
  mockGetAdCampaign: vi.fn(),
  mockGetMarketingAccount: vi.fn(),
  mockCreateAdCreativeVariant: vi.fn(),
  mockGenerateCreativeVariants: vi.fn(),
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
    getAdCampaign: mockGetAdCampaign,
    getMarketingAccount: mockGetMarketingAccount,
    createAdCreativeVariant: mockCreateAdCreativeVariant,
  },
}));

vi.mock("@/lib/marketing/creative-pipeline", () => ({
  generateCreativeVariants: mockGenerateCreativeVariants,
}));

vi.mock("@/lib/marketing/platform-adapter", () => ({
  getMarketingPlatformAdapter: () => ({
    platform: "meta",
    createCreative: vi.fn(),
  }),
}));

import { POST } from "./route";

describe("POST /api/marketing/campaigns/[id]/variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rlsState.active = false;
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockGetAdCampaign.mockImplementation(async () => {
      expect(rlsState.active).toBe(true);
      return {
        id: "camp_1",
        companyId: "co_1",
        marketingAccountId: "ma_1",
        platform: "meta",
        externalCampaignId: "ext_campaign_1",
        name: "Launch Alpha",
        objective: "LEADS",
        status: "draft",
        dailyBudgetCents: 2500,
      };
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
    mockGenerateCreativeVariants.mockResolvedValue({
      variants: [{ id: "creative_1", campaignId: "camp_1" }],
    });
  });

  it("requires auth", async () => {
    mockGetAuthUser.mockResolvedValue(null);

    const res = await POST(jsonRequest(validBody()), params());

    expect(res.status).toBe(401);
  });

  it("requires companyId for tenant-scoped role and RLS checks", async () => {
    const res = await POST(jsonRequest({ offer: "x", audience: "y", angle: "z" }), params());

    expect(res.status).toBe(400);
    expect(mockWithRlsContext).not.toHaveBeenCalled();
  });

  it("requires member role for the submitted company", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });

    const res = await POST(jsonRequest(validBody()), params());

    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "member", { companyId: "co_1" });
  });

  it("applies rate limiting before pipeline generation", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 60 });

    const res = await POST(jsonRequest(validBody()), params());

    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(60);
    expect(mockGenerateCreativeVariants).not.toHaveBeenCalled();
  });

  it("locates the campaign by id inside RLS and rejects missing campaigns", async () => {
    mockGetAdCampaign.mockImplementation(async () => null);

    const res = await POST(jsonRequest(validBody()), params());

    expect(res.status).toBe(404);
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockGetAdCampaign).toHaveBeenCalledWith("camp_1");
    expect(mockGenerateCreativeVariants).not.toHaveBeenCalled();
  });

  it("rejects campaigns outside the submitted company", async () => {
    mockGetAdCampaign.mockImplementation(async () => ({
      id: "camp_1",
      companyId: "co_other",
      marketingAccountId: "ma_1",
      platform: "meta",
    }));

    const res = await POST(jsonRequest(validBody()), params());

    expect(res.status).toBe(404);
    expect(mockGenerateCreativeVariants).not.toHaveBeenCalled();
  });

  it("generates variants for the campaign and account inside RLS", async () => {
    const res = await POST(jsonRequest(validBody()), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetAdCampaign).toHaveBeenCalledWith("camp_1");
    expect(mockGetMarketingAccount).toHaveBeenCalledWith("co_1", "meta");
    expect(mockGenerateCreativeVariants).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      variantCount: 3,
      offer: "AI cofounder OS",
      audience: "solo founders",
      angle: "weekly shipping",
      campaign: expect.objectContaining({ id: "camp_1" }),
      marketingAccount: expect.objectContaining({ id: "ma_1" }),
    }), expect.objectContaining({
      store: expect.any(Object),
      platform: expect.any(Object),
    }));
    expect(body.variants).toEqual([{ id: "creative_1", campaignId: "camp_1" }]);
  });

  it("does not let members weaken brand-safety constraints from the request body", async () => {
    const res = await POST(jsonRequest({
      ...validBody(),
      constraints: {
        allowGuaranteedRevenueClaims: true,
        allowGuaranteedRoasClaims: true,
        allowMedicalPromises: true,
        allowLegalPromises: true,
        allowFinancialPromises: true,
      },
    }), params());

    expect(res.status).toBe(200);
    expect(mockGenerateCreativeVariants).toHaveBeenCalledWith(expect.not.objectContaining({
      constraints: expect.anything(),
    }), expect.any(Object));
  });
});

function validBody() {
  return {
    companyId: "co_1",
    variantCount: 3,
    offer: "AI cofounder OS",
    audience: "solo founders",
    angle: "weekly shipping",
  };
}

function params() {
  return { params: Promise.resolve({ id: "camp_1" }) };
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/marketing/campaigns/camp_1/variants", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
