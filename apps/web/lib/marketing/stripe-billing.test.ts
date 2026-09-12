import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStore, mockStripeClient, mockWithRlsContext } = vi.hoisted(() => ({
  mockStore: {
    getCompany: vi.fn(),
    getStripeCustomer: vi.fn(),
    upsertStripeCustomer: vi.fn(),
    upsertStripeSubscription: vi.fn(),
    hasStripeWebhookEvent: vi.fn(),
    recordStripeWebhookEvent: vi.fn(),
    claimStripeWebhookEvent: vi.fn(),
    markStripeWebhookEventSucceeded: vi.fn(),
    markStripeWebhookEventFailed: vi.fn(),
    updateAdCampaign: vi.fn(),
  },
  mockStripeClient: {
    customers: { create: vi.fn() },
    setupIntents: { create: vi.fn() },
    webhooks: { constructEvent: vi.fn() },
  },
  mockWithRlsContext: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: mockStore,
}));

vi.mock("@/lib/marketing/stripe-client", () => ({
  getStripeClient: () => mockStripeClient,
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: mockWithRlsContext,
}));

import {
  createOffSessionSetupIntent,
  handleStripeWebhook,
  markPaymentMethodReady,
} from "./stripe-billing";

describe("stripe-billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.getCompany.mockResolvedValue({ id: "co_1", name: "Acme" });
    mockStore.getStripeCustomer.mockResolvedValue(null);
    mockStore.upsertStripeCustomer.mockImplementation(async (input) => ({
      id: "sc_1",
      status: "pending",
      ...input,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    }));
    mockStore.hasStripeWebhookEvent.mockResolvedValue(false);
    mockStore.recordStripeWebhookEvent.mockResolvedValue(undefined);
    mockStore.claimStripeWebhookEvent.mockResolvedValue(true);
    mockStore.markStripeWebhookEventSucceeded.mockResolvedValue(undefined);
    mockStore.markStripeWebhookEventFailed.mockResolvedValue(undefined);
    mockStripeClient.customers.create.mockResolvedValue({ id: "cus_123" });
    mockStripeClient.setupIntents.create.mockResolvedValue({ client_secret: "seti_secret_123" });
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<unknown>) => fn());
  });

  it("creates an off-session SetupIntent and reuses the stored customer", async () => {
    mockStore.getStripeCustomer.mockResolvedValue({
      id: "sc_existing",
      companyId: "co_1",
      stripeCustomerId: "cus_existing",
      status: "ready",
    });

    const result = await createOffSessionSetupIntent("co_1");

    expect(result).toEqual({ clientSecret: "seti_secret_123" });
    expect(mockStripeClient.customers.create).not.toHaveBeenCalled();
    expect(mockStripeClient.setupIntents.create).toHaveBeenCalledWith({
      customer: "cus_existing",
      usage: "off_session",
      payment_method_types: ["card"],
      metadata: { companyId: "co_1" },
    });
  });

  it("creates a Stripe customer before creating an off-session SetupIntent", async () => {
    await createOffSessionSetupIntent("co_1");

    expect(mockStripeClient.customers.create).toHaveBeenCalledWith({
      metadata: { companyId: "co_1" },
      name: "Acme",
    });
    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith({
      companyId: "co_1",
      stripeCustomerId: "cus_123",
      status: "pending",
    });
    expect(mockStripeClient.setupIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_123", usage: "off_session" })
    );
  });

  it("marks the payment method ready without storing card data", async () => {
    await markPaymentMethodReady("co_1", "cus_123", "pm_123");

    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith({
      companyId: "co_1",
      stripeCustomerId: "cus_123",
      defaultPaymentMethodId: "pm_123",
      offSessionMandateAcceptedAt: expect.any(String),
      status: "ready",
    });
    expect(JSON.stringify(mockStore.upsertStripeCustomer.mock.calls)).not.toContain("4242");
  });

  it("processes setup_intent.succeeded once per Stripe event id", async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      id: "evt_1",
      type: "setup_intent.succeeded",
      data: {
        object: {
          customer: "cus_123",
          payment_method: "pm_123",
          metadata: { companyId: "co_1" },
        },
      },
    });

    await expect(handleStripeWebhook("{}", "sig_1")).resolves.toEqual({ processed: true });
    expect(mockStore.claimStripeWebhookEvent).toHaveBeenCalledWith("evt_1", "setup_intent.succeeded");
    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", defaultPaymentMethodId: "pm_123" })
    );
    expect(mockStore.markStripeWebhookEventSucceeded).toHaveBeenCalledWith("evt_1");

    mockStore.claimStripeWebhookEvent.mockResolvedValue(false);
    await expect(handleStripeWebhook("{}", "sig_1")).resolves.toEqual({ processed: false });
  });

  it("claims webhook events before side effects so duplicate deliveries do not reprocess", async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      id: "evt_duplicate",
      type: "payment_intent.payment_failed",
      data: { object: { customer: "cus_123", metadata: { companyId: "co_1" } } },
    });
    mockStore.claimStripeWebhookEvent
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(handleStripeWebhook("{}", "sig_1")).resolves.toEqual({ processed: true });
    await expect(handleStripeWebhook("{}", "sig_1")).resolves.toEqual({ processed: false });

    expect(mockStore.claimStripeWebhookEvent).toHaveBeenCalledTimes(2);
    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledTimes(1);
    expect(mockStore.claimStripeWebhookEvent.mock.invocationCallOrder[0])
      .toBeLessThan(mockStore.upsertStripeCustomer.mock.invocationCallOrder[0]);
  });

  it("marks webhook events failed so Stripe retries can reprocess transient side-effect failures", async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      id: "evt_retryable",
      type: "setup_intent.succeeded",
      data: {
        object: {
          customer: "cus_123",
          payment_method: "pm_123",
          metadata: { companyId: "co_1" },
        },
      },
    });
    mockStore.claimStripeWebhookEvent.mockResolvedValue(true);
    mockWithRlsContext
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementationOnce(async (_companyId: string, fn: () => Promise<unknown>) => fn());

    await expect(handleStripeWebhook("{}", "sig_1")).rejects.toThrow("database unavailable");
    expect(mockStore.markStripeWebhookEventFailed).toHaveBeenCalledWith(
      "evt_retryable",
      "database unavailable"
    );

    await expect(handleStripeWebhook("{}", "sig_1")).resolves.toEqual({ processed: true });
    expect(mockStore.claimStripeWebhookEvent).toHaveBeenCalledTimes(2);
    expect(mockStore.markStripeWebhookEventSucceeded).toHaveBeenCalledWith("evt_retryable");
    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready", defaultPaymentMethodId: "pm_123" })
    );
  });

  it("marks payment state blocked on payment failures without mutating campaigns", async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      id: "evt_failed",
      type: "payment_intent.payment_failed",
      data: { object: { customer: "cus_123", metadata: { companyId: "co_1" } } },
    });

    await handleStripeWebhook("{}", "sig_1");

    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith({
      companyId: "co_1",
      stripeCustomerId: "cus_123",
      status: "blocked",
    });
    expect(mockStore.updateAdCampaign).not.toHaveBeenCalled();
  });

  it("marks payment state blocked on requires_action inside RLS", async () => {
    mockStripeClient.webhooks.constructEvent.mockReturnValue({
      id: "evt_action",
      type: "payment_intent.requires_action",
      data: { object: { customer: "cus_123", metadata: { companyId: "co_1" } } },
    });

    await handleStripeWebhook("{}", "sig_1");

    expect(mockWithRlsContext).toHaveBeenCalledWith("co_1", expect.any(Function));
    expect(mockStore.upsertStripeCustomer).toHaveBeenCalledWith({
      companyId: "co_1",
      stripeCustomerId: "cus_123",
      status: "blocked",
    });
    expect(mockStore.updateAdCampaign).not.toHaveBeenCalled();
  });
});
