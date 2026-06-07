import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAdSpendCharge,
  mockCreateAdSpendCharge,
  mockUpdateAdSpendCharge,
  mockGetStripeCustomer,
  mockListMarketingAccounts,
  mockUpdateMarketingAccount,
  mockListAdCampaigns,
  mockUpdateAdCampaign,
  mockCreateApproval,
  mockListApprovals,
  mockAddUsage,
  mockAddAudit,
  mockPaymentIntentsCreate,
  mockAssertSpendAvailable,
  mockFetchInsights,
  mockPauseCampaign,
  mockSetBudget,
} = vi.hoisted(() => ({
  mockGetAdSpendCharge: vi.fn(),
  mockCreateAdSpendCharge: vi.fn(),
  mockUpdateAdSpendCharge: vi.fn(),
  mockGetStripeCustomer: vi.fn(),
  mockListMarketingAccounts: vi.fn(),
  mockUpdateMarketingAccount: vi.fn(),
  mockListAdCampaigns: vi.fn(),
  mockUpdateAdCampaign: vi.fn(),
  mockCreateApproval: vi.fn(),
  mockListApprovals: vi.fn(),
  mockAddUsage: vi.fn(),
  mockAddAudit: vi.fn(),
  mockPaymentIntentsCreate: vi.fn(),
  mockAssertSpendAvailable: vi.fn(),
  mockFetchInsights: vi.fn(),
  mockPauseCampaign: vi.fn(),
  mockSetBudget: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getAdSpendCharge: mockGetAdSpendCharge,
    createAdSpendCharge: mockCreateAdSpendCharge,
    updateAdSpendCharge: mockUpdateAdSpendCharge,
    getStripeCustomer: mockGetStripeCustomer,
    listMarketingAccounts: mockListMarketingAccounts,
    updateMarketingAccount: mockUpdateMarketingAccount,
    listAdCampaigns: mockListAdCampaigns,
    updateAdCampaign: mockUpdateAdCampaign,
    createApproval: mockCreateApproval,
    listApprovals: mockListApprovals,
    addUsage: mockAddUsage,
    addAudit: mockAddAudit,
  },
}));

vi.mock("@/lib/marketing/stripe-client", () => ({
  getStripeClient: () => ({
    paymentIntents: {
      create: mockPaymentIntentsCreate,
    },
  }),
}));

vi.mock("@/lib/spend", () => ({
  assertSpendAvailable: mockAssertSpendAvailable,
}));

vi.mock("@/lib/marketing/platform-adapter", () => ({
  getMarketingPlatformAdapter: () => ({
    fetchInsights: mockFetchInsights,
    pauseCampaign: mockPauseCampaign,
    setBudget: mockSetBudget,
  }),
}));

import { calculatePlatformFee, runDailyAdSpendCharge } from "./spend-loop";

describe("marketing daily spend loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAdSpendCharge.mockResolvedValue(undefined);
    mockCreateAdSpendCharge.mockImplementation(async (input) => ({
      ...input,
      id: "charge_1",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    mockUpdateAdSpendCharge.mockImplementation(async (id, patch) => ({
      id,
      companyId: "co_1",
      billingDate: "2026-05-29",
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: patch.status ?? "succeeded",
      stripePaymentIntentId: patch.stripePaymentIntentId,
      failureCode: patch.failureCode,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    mockGetStripeCustomer.mockResolvedValue({
      companyId: "co_1",
      stripeCustomerId: "cus_1",
      defaultPaymentMethodId: "pm_1",
      status: "ready",
    });
    mockListMarketingAccounts.mockResolvedValue([
      marketingAccount({ id: "acct_1", platform: "meta", paymentStatus: "ready" }),
    ]);
    mockListAdCampaigns.mockResolvedValue([
      adCampaign({ id: "camp_1", marketingAccountId: "acct_1", status: "active", dailyBudgetCents: 5000 }),
      adCampaign({ id: "camp_paused", marketingAccountId: "acct_1", status: "paused", dailyBudgetCents: 5000 }),
    ]);
    mockListApprovals.mockResolvedValue([]);
    mockFetchInsights.mockResolvedValue({
      platform: "meta",
      impressions: 1000,
      clicks: 50,
      spendCents: 1234,
      conversions: 3,
    });
    mockPaymentIntentsCreate.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
    });
  });

  it("calculates platform fees in cents from basis points", () => {
    expect(calculatePlatformFee(10_000, 250)).toBe(250);
    expect(calculatePlatformFee(1_234, 250)).toBe(31);
    expect(calculatePlatformFee(0, 250)).toBe(0);
  });

  it("charges actual ad spend plus platform fee once and records usage plus audit", async () => {
    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.charge.status).toBe("succeeded");
    expect(mockGetAdSpendCharge).toHaveBeenCalledWith("co_1", "2026-05-29");
    expect(mockCreateAdSpendCharge).toHaveBeenCalledWith({
      companyId: "co_1",
      billingDate: "2026-05-29",
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: "pending",
    });
    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(expect.objectContaining({
      amount: 1265,
      currency: "usd",
      customer: "cus_1",
      payment_method: "pm_1",
      confirm: true,
      off_session: true,
      metadata: expect.objectContaining({
        companyId: "co_1",
        billingDate: "2026-05-29",
      }),
    }), expect.objectContaining({
      idempotencyKey: "marketing-daily-spend:co_1:2026-05-29",
    }));
    expect(mockAddUsage).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      category: "ads",
      amountCents: 1265,
      description: "Daily ad spend charge for 2026-05-29",
      metadata: expect.objectContaining({
        adSpendCents: 1234,
        platformFeeCents: 31,
        stripePaymentIntentId: "pi_1",
      }),
    }));
    expect(mockAddAudit).toHaveBeenCalledWith(
      "co_1",
      "system",
      "marketing.spend_charge.succeeded",
      "ad_spend_charge",
      "charge_1",
      "Charged 1265 cents for daily ad spend on 2026-05-29"
    );
  });

  it("returns the existing charge without creating a second PaymentIntent", async () => {
    mockGetAdSpendCharge.mockResolvedValue({
      id: "charge_existing",
      companyId: "co_1",
      billingDate: "2026-05-29",
      stripePaymentIntentId: "pi_existing",
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: "succeeded",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.idempotent).toBe(true);
    expect(result.charge.id).toBe("charge_existing");
    expect(mockCreateAdSpendCharge).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    expect(mockAddUsage).not.toHaveBeenCalled();
  });

  it("uses spend reservation before any platform budget mutation", async () => {
    await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(mockAssertSpendAvailable).toHaveBeenCalledWith(
      "co_1",
      1265,
      "Daily ad spend reservation for 2026-05-29"
    );
    expect(mockSetBudget).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      marketingAccountId: "acct_1",
      externalCampaignId: "ext_camp_1",
      dailyBudgetCents: 5000,
    }));
    expect(callOrder(mockAssertSpendAvailable)).toBeLessThan(callOrder(mockSetBudget));
  });

  it("blocks content mission ad spend until the paid-spend approval is approved", async () => {
    mockListAdCampaigns.mockResolvedValue([
      adCampaign({
        id: "camp_mission",
        marketingAccountId: "acct_1",
        status: "active",
        dailyBudgetCents: 5000,
        approvalId: "approval_mission_spend",
      }),
    ]);
    mockListApprovals.mockResolvedValue([
      {
        id: "approval_mission_spend",
        companyId: "co_1",
        action: "content_mission.paid_spend_or_boost",
        reason: "Approve paid campaign spend",
        status: "pending",
        createdAt: "2026-06-04T00:00:00.000Z",
        toolName: "content_mission:orc_1:action_paid_spend_or_boost",
      },
    ]);

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.charge.status).toBe("failed");
    expect(result.charge.failureCode).toBe("content_mission_spend_approval_required");
    expect(mockFetchInsights).not.toHaveBeenCalled();
    expect(mockAssertSpendAvailable).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
    expect(mockSetBudget).not.toHaveBeenCalled();
    expect(mockAddAudit).toHaveBeenCalledWith(
      "co_1",
      "system",
      "marketing.spend_charge.blocked_approval",
      "ad_spend_charge",
      "charge_1",
      expect.stringContaining("camp_mission")
    );
  });

  it("allows content mission ad spend after the paid-spend approval is approved", async () => {
    mockListAdCampaigns.mockResolvedValue([
      adCampaign({
        id: "camp_mission",
        marketingAccountId: "acct_1",
        status: "active",
        dailyBudgetCents: 5000,
        approvalId: "approval_mission_spend",
      }),
    ]);
    mockListApprovals.mockResolvedValue([
      {
        id: "approval_mission_spend",
        companyId: "co_1",
        action: "content_mission.paid_spend_or_boost",
        reason: "Approve paid campaign spend",
        status: "approved",
        createdAt: "2026-06-04T00:00:00.000Z",
        toolName: "content_mission:orc_1:action_paid_spend_or_boost",
      },
    ]);

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.charge.status).toBe("succeeded");
    expect(mockFetchInsights).toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).toHaveBeenCalled();
    expect(mockSetBudget).toHaveBeenCalled();
  });

  it("passes a stable Stripe idempotency key for the billing date", async () => {
    await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: "marketing-daily-spend:co_1:2026-05-29",
    });
  });

  it("retries a failed charge for the same billing date after payment recovery", async () => {
    mockGetAdSpendCharge.mockResolvedValue({
      id: "charge_failed",
      companyId: "co_1",
      billingDate: "2026-05-29",
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: "failed",
      failureCode: "payment_method_unavailable",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.idempotent).toBe(false);
    expect(mockCreateAdSpendCharge).not.toHaveBeenCalled();
    expect(mockPaymentIntentsCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdateAdSpendCharge).toHaveBeenCalledWith("charge_failed", expect.objectContaining({
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: "succeeded",
      failureCode: null,
      stripePaymentIntentId: "pi_1",
    }));
  });

  it("refreshes failed retry totals when the retry fails again", async () => {
    mockGetAdSpendCharge.mockResolvedValue({
      id: "charge_failed",
      companyId: "co_1",
      billingDate: "2026-05-29",
      adSpendCents: 100,
      platformFeeCents: 5,
      status: "failed",
      failureCode: "payment_failed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    });
    mockPaymentIntentsCreate.mockResolvedValue({
      id: "pi_requires_action",
      status: "requires_action",
      last_payment_error: { code: "authentication_required" },
    });

    await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(mockUpdateAdSpendCharge).toHaveBeenCalledWith("charge_failed", expect.objectContaining({
      adSpendCents: 1234,
      platformFeeCents: 31,
      status: "failed",
      failureCode: "authentication_required",
    }));
  });

  it("rejects mixed ready account currencies instead of charging the wrong currency", async () => {
    mockListMarketingAccounts.mockResolvedValue([
      marketingAccount({ id: "acct_1", platform: "meta", currency: "USD", paymentStatus: "ready" }),
      marketingAccount({ id: "acct_2", platform: "google", currency: "EUR", paymentStatus: "ready" }),
    ]);
    mockListAdCampaigns.mockResolvedValue([
      adCampaign({ id: "camp_1", marketingAccountId: "acct_1", platform: "meta", status: "active" }),
      adCampaign({ id: "camp_2", marketingAccountId: "acct_2", platform: "google", status: "active" }),
    ]);

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.charge.status).toBe("failed");
    expect(result.charge.failureCode).toBe("mixed_currency_accounts");
    expect(mockPaymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("does not leak raw Stripe error messages into approval or audit text", async () => {
    mockPaymentIntentsCreate.mockRejectedValue(new Error("card leaked email test@example.com and token sk_live_bad"));

    await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    const approval = JSON.stringify(mockCreateApproval.mock.calls[0][0]);
    const audit = JSON.stringify(mockAddAudit.mock.calls[0]);
    expect(approval).toContain("payment_failed");
    expect(audit).toContain("payment_failed");
    expect(approval).not.toContain("test@example.com");
    expect(audit).not.toContain("sk_live_bad");
  });

  it("blocks payment and pauses only active campaigns when Stripe requires action", async () => {
    mockPaymentIntentsCreate.mockResolvedValue({
      id: "pi_requires_action",
      status: "requires_action",
      last_payment_error: { code: "authentication_required" },
    });

    const result = await runDailyAdSpendCharge("co_1", "2026-05-29", { feeBps: 250 });

    expect(result.charge.status).toBe("failed");
    expect(mockUpdateMarketingAccount).toHaveBeenCalledWith("acct_1", {
      paymentStatus: "payment_blocked",
      status: "paused",
    });
    expect(mockUpdateAdCampaign).toHaveBeenCalledTimes(1);
    expect(mockUpdateAdCampaign).toHaveBeenCalledWith("camp_1", { status: "paused" });
    expect(mockUpdateAdCampaign).not.toHaveBeenCalledWith("camp_paused", expect.anything());
    expect(mockPauseCampaign).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      marketingAccountId: "acct_1",
      externalCampaignId: "ext_camp_1",
    }));
    expect(mockCreateApproval).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      action: "Resolve blocked marketing payment",
      reason: "Daily ad spend payment for 2026-05-29 failed: authentication_required",
      toolName: "marketing.spend.daily",
      previewKind: "generic",
    }));
    expect(mockAddAudit).toHaveBeenCalledWith(
      "co_1",
      "system",
      "marketing.spend_charge.failed",
      "ad_spend_charge",
      "charge_1",
      "Payment blocked daily ad spend for 2026-05-29: authentication_required"
    );
  });
});

function marketingAccount(patch: Record<string, unknown>) {
  return {
    id: "acct_1",
    companyId: "co_1",
    platform: "meta",
    status: "active",
    externalAccountId: "act_1",
    currency: "USD",
    dailyBudgetCents: 5000,
    paymentStatus: "ready",
    consentForServerEvents: true,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}

function adCampaign(patch: Record<string, unknown>) {
  return {
    id: "camp_1",
    companyId: "co_1",
    marketingAccountId: "acct_1",
    platform: "meta",
    externalCampaignId: "ext_camp_1",
    name: "Daily lead gen",
    objective: "LEADS",
    status: "active",
    dailyBudgetCents: 5000,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}

function callOrder(mock: { mock: { invocationCallOrder: number[] } }) {
  return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
}
