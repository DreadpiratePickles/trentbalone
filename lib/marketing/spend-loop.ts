import { getMarketingPlatformAdapter } from "@/lib/marketing/platform-adapter";
import type { AdCampaign, AdSpendCharge, MarketingAccount } from "@/lib/marketing/types";
import { getStripeClient } from "@/lib/marketing/stripe-client";
import { assertContentMissionExternalActionAllowed } from "@/lib/content-mission-approvals";
import { buildPlatformAuthReadiness } from "@/lib/platform-auth-readiness";
import { markContentMissionActionExecuted } from "@/lib/content-mission-store";
import { assertSpendAvailable } from "@/lib/spend";
import { store } from "@/lib/store";
import type { Approval } from "@/lib/types";

const DEFAULT_PLATFORM_FEE_BPS = 500;

type SpendLoopStore = typeof store & {
  getAdSpendCharge(companyId: string, billingDate: string): Promise<AdSpendCharge | undefined>;
  createAdSpendCharge(input: Omit<AdSpendCharge, "id" | "createdAt" | "updatedAt">): Promise<AdSpendCharge>;
  updateAdSpendCharge(id: string, patch: Partial<AdSpendCharge>): Promise<AdSpendCharge | undefined>;
  listMarketingAccounts(companyId: string): Promise<MarketingAccount[]>;
  updateMarketingAccount(id: string, patch: Partial<MarketingAccount>): Promise<MarketingAccount | undefined>;
  listAdCampaigns(companyId: string): Promise<AdCampaign[]>;
  updateAdCampaign(id: string, patch: Partial<AdCampaign>): Promise<AdCampaign | undefined>;
  createApproval(input: Parameters<typeof store.createApproval>[0]): ReturnType<typeof store.createApproval>;
  listApprovals(companyId: string): Promise<Approval[]>;
};

export type DailySpendChargeResult = {
  idempotent: boolean;
  charge: AdSpendCharge;
};

export type DailySpendChargeOptions = {
  feeBps?: number;
};

export function calculatePlatformFee(adSpendCents: number, feeBps: number) {
  if (!Number.isInteger(adSpendCents) || adSpendCents < 0) {
    throw new Error("adSpendCents must be a non-negative integer");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new Error("feeBps must be a non-negative integer");
  }
  return Math.round((adSpendCents * feeBps) / 10_000);
}

export async function runDailyAdSpendCharge(
  companyId: string,
  billingDate: string,
  options: DailySpendChargeOptions = {}
): Promise<DailySpendChargeResult> {
  assertBillingDate(billingDate);
  const marketingStore = requireSpendLoopStore();
  const existing = await marketingStore.getAdSpendCharge(companyId, billingDate);
  if (existing?.status === "succeeded") return { idempotent: true, charge: existing };

  const accounts = await marketingStore.listMarketingAccounts(companyId);
  const readyAccounts = accounts.filter(
    (account) => account.status === "active" && account.paymentStatus === "ready"
  );
  const accountById = new Map(readyAccounts.map((account) => [account.id, account]));
  const activeCampaigns = (await marketingStore.listAdCampaigns(companyId))
    .filter((campaign) => campaign.status === "active" && accountById.has(campaign.marketingAccountId));
  const approvals = await marketingStore.listApprovals(companyId);
  const approvalBlockers = findPaidSpendApprovalBlockers(
    companyId,
    activeCampaigns,
    accountById,
    approvals,
  );
  if (approvalBlockers.length > 0) {
    const pendingCharge = existing ?? await marketingStore.createAdSpendCharge({
      companyId,
      billingDate,
      adSpendCents: 0,
      platformFeeCents: 0,
      status: "pending",
    });
    return blockChargeForApproval(companyId, billingDate, pendingCharge, approvalBlockers);
  }
  const currency = currencyForCampaigns(activeCampaigns, accountById);
  if (!currency) {
    const pendingCharge = existing ?? await marketingStore.createAdSpendCharge({
      companyId,
      billingDate,
      adSpendCents: 0,
      platformFeeCents: 0,
      status: "pending",
    });
    return failCharge(companyId, billingDate, pendingCharge, "mixed_currency_accounts");
  }

  const adSpendCents = await fetchDailySpendCents(activeCampaigns, accountById, billingDate);
  const platformFeeCents = calculatePlatformFee(adSpendCents, options.feeBps ?? DEFAULT_PLATFORM_FEE_BPS);
  const pendingCharge = existing ?? await marketingStore.createAdSpendCharge({
    companyId,
    billingDate,
    adSpendCents,
    platformFeeCents,
    status: "pending",
  });

  const amount = adSpendCents + platformFeeCents;
  await reserveAdSpendBudget(companyId, billingDate, amount);

  let paymentIntentId: string | undefined;
  if (amount > 0) {
    const customer = await marketingStore.getStripeCustomer(companyId);
    if (!customer?.stripeCustomerId || !customer.defaultPaymentMethodId || customer.status !== "ready") {
      return failCharge(companyId, billingDate, pendingCharge, "payment_method_unavailable");
    }

    try {
      const paymentIntent = await getStripeClient().paymentIntents.create(
        {
          amount,
          currency,
          customer: customer.stripeCustomerId,
          payment_method: customer.defaultPaymentMethodId,
          confirm: true,
          off_session: true,
          metadata: {
            companyId,
            billingDate,
            adSpendCents: String(adSpendCents),
            platformFeeCents: String(platformFeeCents),
          },
        },
        { idempotencyKey: stripeIdempotencyKey(companyId, billingDate) }
      );
      paymentIntentId = paymentIntent.id;
      if (paymentIntent.status !== "succeeded") {
        const failureCode = sanitizeFailureCode(paymentIntent.last_payment_error?.code ?? paymentIntent.status);
        return failCharge(companyId, billingDate, pendingCharge, failureCode, {
          adSpendCents,
          platformFeeCents,
          stripePaymentIntentId: paymentIntentId,
        });
      }
    } catch (err) {
      return failCharge(companyId, billingDate, pendingCharge, errorCode(err), {
        adSpendCents,
        platformFeeCents,
        stripePaymentIntentId: paymentIntentId,
      });
    }
  }

  const succeeded = await marketingStore.updateAdSpendCharge(pendingCharge.id, {
    adSpendCents,
    platformFeeCents,
    status: "succeeded",
    failureCode: null,
    stripePaymentIntentId: paymentIntentId,
  }) ?? pendingCharge;

  await marketingStore.addUsage({
    companyId,
    category: "ads",
    amountCents: amount,
    description: `Daily ad spend charge for ${billingDate}`,
    metadata: {
      billingDate,
      adSpendCents,
      platformFeeCents,
      adSpendChargeId: pendingCharge.id,
      stripePaymentIntentId: paymentIntentId ?? "",
    },
  });
  await marketingStore.addAudit(
    companyId,
    "system",
    "marketing.spend_charge.succeeded",
    "ad_spend_charge",
    pendingCharge.id,
    `Charged ${amount} cents for daily ad spend on ${billingDate}`
  );

  await markSpendLoopMissionsExecuted(activeCampaigns, approvals);
  await applyPlatformBudgets(activeCampaigns, accountById);
  return { idempotent: false, charge: succeeded };
}

export async function pauseCampaignsForPaymentFailure(companyId: string, reason: string) {
  const marketingStore = requireSpendLoopStore();
  const accounts = await marketingStore.listMarketingAccounts(companyId);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  await Promise.all(accounts.map((account) =>
    marketingStore.updateMarketingAccount(account.id, {
      paymentStatus: "payment_blocked",
      status: "paused",
    })
  ));

  const activeCampaigns = (await marketingStore.listAdCampaigns(companyId))
    .filter((campaign) => campaign.status === "active");
  for (const campaign of activeCampaigns) {
    const account = accountById.get(campaign.marketingAccountId);
    if (account?.externalAccountId && campaign.externalCampaignId) {
      await getMarketingPlatformAdapter(campaign.platform).pauseCampaign({
        companyId,
        marketingAccountId: account.id,
        externalAccountId: account.externalAccountId,
        externalCampaignId: campaign.externalCampaignId,
      });
    }
    await marketingStore.updateAdCampaign(campaign.id, { status: "paused" });
  }
  await marketingStore.addAudit(
    companyId,
    "system",
    "marketing.payment_blocked",
    "marketing_account",
    companyId,
    `Paused active marketing campaigns after payment failure: ${reason}`
  );
}

export async function resumeCampaignsAfterPaymentRecovery(companyId: string) {
  const marketingStore = requireSpendLoopStore();
  const accounts = await marketingStore.listMarketingAccounts(companyId);
  await Promise.all(accounts.map((account) =>
    marketingStore.updateMarketingAccount(account.id, {
      paymentStatus: "ready",
      status: "active",
    })
  ));
  await marketingStore.addAudit(
    companyId,
    "system",
    "marketing.payment_recovered",
    "marketing_account",
    companyId,
    "Marketing payment method recovered; account budgets may resume after review"
  );
}

async function fetchDailySpendCents(
  campaigns: AdCampaign[],
  accountById: Map<string, MarketingAccount>,
  billingDate: string
) {
  let total = 0;
  for (const campaign of campaigns) {
    const account = accountById.get(campaign.marketingAccountId);
    if (!account?.externalAccountId || !campaign.externalCampaignId) continue;
    const insights = await getMarketingPlatformAdapter(campaign.platform).fetchInsights({
      companyId: campaign.companyId,
      marketingAccountId: account.id,
      externalAccountId: account.externalAccountId,
      externalCampaignId: campaign.externalCampaignId,
      since: billingDate,
      until: billingDate,
    });
    total += Math.max(0, insights.spendCents);
  }
  return total;
}

async function reserveAdSpendBudget(companyId: string, billingDate: string, adSpendCents: number) {
  await assertSpendAvailable(
    companyId,
    adSpendCents,
    `Daily ad spend reservation for ${billingDate}`
  );
}

async function applyPlatformBudgets(campaigns: AdCampaign[], accountById: Map<string, MarketingAccount>) {
  for (const campaign of campaigns) {
    const account = accountById.get(campaign.marketingAccountId);
    if (!account?.externalAccountId || !campaign.externalCampaignId) continue;
    await getMarketingPlatformAdapter(campaign.platform).setBudget({
      companyId: campaign.companyId,
      marketingAccountId: account.id,
      externalAccountId: account.externalAccountId,
      externalCampaignId: campaign.externalCampaignId,
      dailyBudgetCents: campaign.dailyBudgetCents,
    });
  }
}

function findPaidSpendApprovalBlockers(
  companyId: string,
  campaigns: AdCampaign[],
  accountById: Map<string, MarketingAccount>,
  approvals: Approval[],
) {
  const byId = new Map(approvals.map((approval) => [approval.id, approval]));
  const blockers: string[] = [];
  for (const campaign of campaigns) {
    if (!campaign.approvalId) continue;
    const approval = byId.get(campaign.approvalId);
    if (!approval) {
      blockers.push(`Campaign ${campaign.id} is linked to a missing paid-spend approval.`);
      continue;
    }
    if (!approval.action.startsWith("content_mission.")) continue;
    const runId = contentMissionRunId(approval.toolName);
    if (!runId) {
      blockers.push(`Campaign ${campaign.id} has a malformed content mission approval.`);
      continue;
    }
    try {
      assertContentMissionExternalActionAllowed({
        companyId,
        runId,
        kind: "paid_spend_or_boost",
        approvals,
        platformReadiness: buildPlatformAuthReadiness({
          marketingAccounts: [accountById.get(campaign.marketingAccountId)].filter((account): account is MarketingAccount => Boolean(account)),
          requiredMarketingPlatforms: [campaign.platform],
          paidAdsRequested: true,
        }),
      });
    } catch (error) {
      blockers.push(`Campaign ${campaign.id}: ${error instanceof Error ? error.message : "paid spend approval is not ready"}`);
    }
  }
  return blockers;
}

async function blockChargeForApproval(
  companyId: string,
  billingDate: string,
  pendingCharge: AdSpendCharge,
  blockers: string[],
): Promise<DailySpendChargeResult> {
  const marketingStore = requireSpendLoopStore();
  const failed = await marketingStore.updateAdSpendCharge(pendingCharge.id, {
    adSpendCents: 0,
    platformFeeCents: 0,
    status: "failed",
    failureCode: "content_mission_spend_approval_required",
  }) ?? pendingCharge;
  await marketingStore.addAudit(
    companyId,
    "system",
    "marketing.spend_charge.blocked_approval",
    "ad_spend_charge",
    pendingCharge.id,
    `Blocked daily ad spend for ${billingDate}: ${blockers.join("; ")}`
  );
  return { idempotent: false, charge: failed };
}

async function markSpendLoopMissionsExecuted(
  campaigns: AdCampaign[],
  approvals: Approval[],
): Promise<void> {
  const approvalById = new Map(approvals.map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const campaign of campaigns) {
    if (!campaign.approvalId) continue;
    const approval = approvalById.get(campaign.approvalId);
    const runId = contentMissionRunId(approval?.toolName);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    await markContentMissionActionExecuted({ runId, kind: "paid_spend_or_boost" }).catch(() => undefined);
  }
}

function contentMissionRunId(toolName?: string) {
  const match = /^content_mission:([^:]+):action_paid_spend_or_boost$/.exec(toolName ?? "");
  return match?.[1];
}

async function failCharge(
  companyId: string,
  billingDate: string,
  pendingCharge: AdSpendCharge,
  failureCode: string,
  details: {
    adSpendCents?: number;
    platformFeeCents?: number;
    stripePaymentIntentId?: string;
  } = {}
): Promise<DailySpendChargeResult> {
  const marketingStore = requireSpendLoopStore();
  const failed = await marketingStore.updateAdSpendCharge(pendingCharge.id, {
    adSpendCents: details.adSpendCents ?? pendingCharge.adSpendCents,
    platformFeeCents: details.platformFeeCents ?? pendingCharge.platformFeeCents,
    status: "failed",
    failureCode,
    stripePaymentIntentId: details.stripePaymentIntentId,
  }) ?? pendingCharge;
  await pauseCampaignsForPaymentFailure(companyId, failureCode);
  await marketingStore.createApproval({
    companyId,
    action: "Resolve blocked marketing payment",
    reason: `Daily ad spend payment for ${billingDate} failed: ${failureCode}`,
    toolName: "marketing.spend.daily",
    previewKind: "generic",
    previewContent: JSON.stringify({ billingDate, failureCode, stripePaymentIntentId: details.stripePaymentIntentId }),
  });
  await marketingStore.addAudit(
    companyId,
    "system",
    "marketing.spend_charge.failed",
    "ad_spend_charge",
    pendingCharge.id,
    `Payment blocked daily ad spend for ${billingDate}: ${failureCode}`
  );
  return { idempotent: false, charge: failed };
}

function currencyForCampaigns(campaigns: AdCampaign[], accountById: Map<string, MarketingAccount>) {
  const currencies = new Set<string>();
  for (const campaign of campaigns) {
    const account = accountById.get(campaign.marketingAccountId);
    if (account) currencies.add(account.currency.toLowerCase());
  }
  if (currencies.size > 1) return null;
  return currencies.values().next().value ?? "usd";
}

function stripeIdempotencyKey(companyId: string, billingDate: string) {
  return `marketing-daily-spend:${companyId}:${billingDate}`;
}

function errorCode(err: unknown) {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return sanitizeFailureCode((err as { code: string }).code);
  }
  return "payment_failed";
}

function sanitizeFailureCode(value: unknown) {
  if (typeof value === "string" && /^[a-z0-9_]+$/i.test(value)) return value.toLowerCase();
  return "payment_failed";
}

function assertBillingDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("billingDate must be YYYY-MM-DD");
}

function requireSpendLoopStore() {
  const marketingStore = store as typeof store & Partial<SpendLoopStore>;
  const requiredMethods = [
    "getAdSpendCharge",
    "createAdSpendCharge",
    "updateAdSpendCharge",
    "getStripeCustomer",
    "listMarketingAccounts",
    "updateMarketingAccount",
    "listAdCampaigns",
    "updateAdCampaign",
    "createApproval",
    "listApprovals",
    "addUsage",
    "addAudit",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof marketingStore[method] !== "function") {
      throw new Error(`Marketing spend store method is not available: ${method}`);
    }
  }
  return marketingStore as SpendLoopStore;
}
