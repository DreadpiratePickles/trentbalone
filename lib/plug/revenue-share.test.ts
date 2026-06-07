import { describe, expect, it, vi } from "vitest";
import {
  createCreatorRevenueShareTransfer,
  planCreatorRevenueShare,
} from "@/lib/plug/revenue-share";

describe("Plug creator revenue share", () => {
  it("creates a Stripe Connect transfer with creator ownership metadata", async () => {
    const stripeConnectClient = {
      transfers: {
        create: vi.fn().mockResolvedValue({ id: "tr_123" }),
      },
    };

    const result = await createCreatorRevenueShareTransfer({
      plugId: "plug_weekly_ops_review",
      runId: "run_123",
      publisherId: "pub_trent",
      creatorStripeAccountId: "acct_creator_123",
      grossCents: 10000,
      platformFeeBps: 2000,
      stripeFeeCents: 350,
    }, { stripeConnectClient });

    expect(result).toEqual({
      status: "created",
      transferId: "tr_123",
      plan: planCreatorRevenueShare({ grossCents: 10000, platformFeeBps: 2000, stripeFeeCents: 350 }),
    });
    expect(stripeConnectClient.transfers.create).toHaveBeenCalledWith({
      amount: 7650,
      currency: "usd",
      destination: "acct_creator_123",
      transfer_group: "plug_run_run_123",
      metadata: {
        plugId: "plug_weekly_ops_review",
        runId: "run_123",
        publisherId: "pub_trent",
        grossCents: "10000",
        platformFeeCents: "2000",
        stripeFeeCents: "350",
      },
    }, { idempotencyKey: "plug_run_123_creator_acct_creator_123" });
  });

  it("marks live validation pending when Stripe Connect is not configured", async () => {
    await expect(createCreatorRevenueShareTransfer({
      plugId: "plug_weekly_ops_review",
      runId: "run_123",
      publisherId: "pub_trent",
      creatorStripeAccountId: "acct_creator_123",
      grossCents: 10000,
      platformFeeBps: 2000,
      stripeFeeCents: 350,
    })).resolves.toMatchObject({
      status: "live_validation_pending",
      reason: "missing_stripe_connect_client",
    });
  });
});
