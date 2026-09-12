import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyStripeSignature } from "@/lib/marketing/stripe-client";

const { mockHandleStripeWebhook, mockGetAuthUser } = vi.hoisted(() => ({
  mockHandleStripeWebhook: vi.fn(),
  mockGetAuthUser: vi.fn(),
}));

vi.mock("@/lib/marketing/stripe-billing", () => ({
  handleStripeWebhook: mockHandleStripeWebhook,
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
}));

import { POST } from "./route";

describe("POST /api/marketing/stripe/webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleStripeWebhook.mockResolvedValue({ processed: true });
  });

  it("passes the raw request body and Stripe signature to the billing handler", async () => {
    const res = await POST(
      new Request("http://x/api/marketing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig_123" },
        body: "{\"id\":\"evt_1\"}",
      })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: true });
    expect(mockHandleStripeWebhook).toHaveBeenCalledWith("{\"id\":\"evt_1\"}", "sig_123");
  });

  it("does not require user authentication", async () => {
    await POST(
      new Request("http://x/api/marketing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "sig_123" },
        body: "{}",
      })
    );

    expect(mockGetAuthUser).not.toHaveBeenCalled();
  });

  it("rejects requests without a Stripe signature", async () => {
    const res = await POST(
      new Request("http://x/api/marketing/stripe/webhook", {
        method: "POST",
        body: "{}",
      })
    );

    expect(res.status).toBe(400);
    expect(mockHandleStripeWebhook).not.toHaveBeenCalled();
  });

  it("rejects stale Stripe signatures before processing", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/marketing/stripe-billing");
    vi.doUnmock("@/lib/marketing/stripe-client");
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const { POST: actualPost } = await import("./route");
    const rawBody = JSON.stringify({
      id: "evt_stale",
      type: "payment_intent.payment_failed",
      data: { object: { customer: "cus_123", metadata: { companyId: "co_1" } } },
    });
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = createHmac("sha256", "whsec_test")
      .update(`${staleTimestamp}.${rawBody}`)
      .digest("hex");

    const res = await actualPost(
      new Request("http://x/api/marketing/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": `t=${staleTimestamp},v1=${signature}` },
        body: rawBody,
      })
    );

    process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    expect(res.status).toBe(400);
    expect(mockHandleStripeWebhook).not.toHaveBeenCalled();
  });

  it("rejects otherwise valid signatures older than five minutes", () => {
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const rawBody = "{\"id\":\"evt_stale\"}";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
    const signature = createHmac("sha256", "whsec_test")
      .update(`${staleTimestamp}.${rawBody}`)
      .digest("hex");

    expect(() =>
      verifyStripeSignature(rawBody, `t=${staleTimestamp},v1=${signature}`)
    ).toThrow("stale");

    process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  });

  it("accepts any matching v1 Stripe signature during secret rotation windows", () => {
    const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    const rawBody = "{\"id\":\"evt_multi_v1\"}";
    const timestamp = Math.floor(Date.now() / 1000);
    const validSignature = createHmac("sha256", "whsec_test")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    expect(() =>
      verifyStripeSignature(rawBody, `t=${timestamp},v1=bad_signature,v1=${validSignature}`)
    ).not.toThrow();

    process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  });
});
