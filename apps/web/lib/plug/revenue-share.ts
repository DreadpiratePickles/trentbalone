export type CreatorRevenueSharePlan = {
  grossCents: number;
  platformFeeCents: number;
  stripeFeeCents: number;
  creatorGrossCents: number;
};

export type StripeConnectTransferClient = {
  transfers: {
    create: (
      input: {
        amount: number;
        currency: string;
        destination: string;
        transfer_group: string;
        metadata: Record<string, string>;
      },
      options: { idempotencyKey: string }
    ) => Promise<{ id: string }>;
  };
};

export type CreatorRevenueShareTransferInput = {
  plugId: string;
  runId: string;
  publisherId: string;
  creatorStripeAccountId: string;
  grossCents: number;
  platformFeeBps: number;
  stripeFeeCents: number;
  currency?: string;
};

export type CreatorRevenueShareTransferResult =
  | { status: "created"; transferId: string; plan: CreatorRevenueSharePlan }
  | { status: "live_validation_pending"; reason: "missing_stripe_connect_client"; plan: CreatorRevenueSharePlan };

export function planCreatorRevenueShare(input: { grossCents: number; platformFeeBps: number; stripeFeeCents: number }): CreatorRevenueSharePlan {
  const platformFeeCents = Math.round((input.grossCents * input.platformFeeBps) / 10000);
  const creatorGrossCents = input.grossCents - platformFeeCents - input.stripeFeeCents;
  return { grossCents: input.grossCents, platformFeeCents, stripeFeeCents: input.stripeFeeCents, creatorGrossCents };
}

export async function createCreatorRevenueShareTransfer(
  input: CreatorRevenueShareTransferInput,
  deps: { stripeConnectClient?: StripeConnectTransferClient } = {},
): Promise<CreatorRevenueShareTransferResult> {
  const plan = planCreatorRevenueShare(input);
  if (!deps.stripeConnectClient) {
    return { status: "live_validation_pending", reason: "missing_stripe_connect_client", plan };
  }

  const transfer = await deps.stripeConnectClient.transfers.create({
    amount: plan.creatorGrossCents,
    currency: input.currency ?? "usd",
    destination: input.creatorStripeAccountId,
    transfer_group: `plug_run_${input.runId}`,
    metadata: {
      plugId: input.plugId,
      runId: input.runId,
      publisherId: input.publisherId,
      grossCents: String(plan.grossCents),
      platformFeeCents: String(plan.platformFeeCents),
      stripeFeeCents: String(plan.stripeFeeCents),
    },
  }, { idempotencyKey: `plug_${input.runId}_creator_${input.creatorStripeAccountId}` });

  return { status: "created", transferId: transfer.id, plan };
}
