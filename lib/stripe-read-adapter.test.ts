import { describe, expect, it, vi } from "vitest";
import { createStripeReadAdapter, summarizeStripeSubscriptions } from "./stripe-read-adapter";

describe("Stripe read adapter", () => {
  it("fails closed without credentials instead of returning mocked billing data", async () => {
    const adapter = createStripeReadAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute("read_snapshot", {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("STRIPE_SECRET_KEY");
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("reads balance and subscriptions without requiring approval", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        available: [{ amount: 12000, currency: "usd" }],
        pending: [{ amount: 3400, currency: "usd" }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [
          {
            id: "sub_1",
            status: "active",
            currency: "usd",
            items: { data: [{ quantity: 2, price: { unit_amount: 5000, recurring: { interval: "month" } } }] },
          },
          {
            id: "sub_2",
            status: "canceled",
            currency: "usd",
            items: { data: [{ quantity: 1, price: { unit_amount: 120000, recurring: { interval: "year" } } }] },
          },
        ],
      }), { status: 200 }));
    const adapter = createStripeReadAdapter({ env: { STRIPE_SECRET_KEY: "sk_test_secret" }, fetchImpl });

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("read_snapshot")).toBe(false);
    const result = await adapter.execute("read_snapshot", {});

    expect(fetchImpl).toHaveBeenCalledWith("https://api.stripe.com/v1/balance", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer sk_test_secret" }),
    }));
    expect(fetchImpl).toHaveBeenCalledWith("https://api.stripe.com/v1/subscriptions?status=all&limit=100&expand%5B%5D=data.items.data.price", expect.objectContaining({
      method: "GET",
    }));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("active subscriptions: 1");
    expect(result.summary).toContain("MRR: USD 100.00");
    expect(result.summary).not.toContain("sk_test_secret");
  });

  it("fails closed when the Stripe secret was pasted with non-header characters", async () => {
    const fetchImpl = vi.fn();
    const adapter = createStripeReadAdapter({ env: { STRIPE_SECRET_KEY: "sk_bad\u0441" }, fetchImpl });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");
    const result = await adapter.execute("read_snapshot", {});

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("malformed");
    expect(result.summary).not.toContain("sk_bad");
  });

  it("refuses write actions even if a caller tries to use the Stripe tool for charging", async () => {
    const adapter = createStripeReadAdapter({ env: { STRIPE_SECRET_KEY: "sk_test_secret" }, fetchImpl: vi.fn() });

    expect(adapter.requiresApproval("refund customer")).toBe(true);
    const result = await adapter.execute("refund customer", { approvalId: "approval_1" });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("read-only");
  });
});

describe("summarizeStripeSubscriptions", () => {
  it("converts monthly and yearly active subscriptions into MRR cents", () => {
    const summary = summarizeStripeSubscriptions([
      {
        id: "sub_month",
        status: "active",
        currency: "usd",
        items: { data: [{ quantity: 3, price: { unit_amount: 1000, recurring: { interval: "month" } } }] },
      },
      {
        id: "sub_year",
        status: "trialing",
        currency: "usd",
        items: { data: [{ quantity: 1, price: { unit_amount: 120000, recurring: { interval: "year" } } }] },
      },
      {
        id: "sub_cancel",
        status: "canceled",
        currency: "usd",
        items: { data: [{ quantity: 1, price: { unit_amount: 5000, recurring: { interval: "month" } } }] },
      },
    ]);

    expect(summary.activeCount).toBe(2);
    expect(summary.mrrByCurrency.usd).toBe(13000);
  });
});
