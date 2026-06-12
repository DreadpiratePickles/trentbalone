import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { isHttpHeaderValueSafe, malformedCredentialSummary } from "@/lib/http-credential";

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

export type StripeReadAdapterOptions = {
  env?: EnvLike;
  fetchImpl?: FetchLike;
};

type StripeBalance = {
  available?: Array<{ amount?: number; currency?: string }>;
  pending?: Array<{ amount?: number; currency?: string }>;
};

type StripeSubscription = {
  id?: string;
  status?: string;
  currency?: string;
  items?: {
    data?: Array<{
      quantity?: number;
      price?: {
        unit_amount?: number | null;
        recurring?: { interval?: string | null } | null;
      } | null;
    }>;
  };
};

const STRIPE_BASE = "https://api.stripe.com";
const WRITE_ACTION_RE = /\b(charge|refund|withdraw|payout|transfer|create|delete|update|cancel)\b/i;

export function createStripeReadAdapter(options: StripeReadAdapterOptions = {}): ToolAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = stripeSecret(env);
  const configured = Boolean(token && isHttpHeaderValueSafe(token));

  return {
    name: "Stripe",
    scopes: ["stripe:balance:read", "stripe:subscriptions:read", "stripe:mrr:read"],
    availability: configured ? "real" : "unavailable",
    async healthCheck() {
      const secret = stripeSecret(env);
      return secret && isHttpHeaderValueSafe(secret) ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action) {
      return WRITE_ACTION_RE.test(action);
    },
    async execute(action) {
      const secretKey = stripeSecret(env);
      if (!secretKey) {
        return failed(action, "Stripe is not configured. Set STRIPE_SECRET_KEY before agents can read real billing data.");
      }
      if (!isHttpHeaderValueSafe(secretKey)) {
        return failed(action, malformedCredentialSummary("Stripe secret key"));
      }
      if (WRITE_ACTION_RE.test(action)) {
        return failed(action, "Stripe adapter is read-only in this agent tool path. Charges, refunds, payouts, and subscription mutations must use dedicated approval-gated billing flows.");
      }

      try {
        const [balance, subscriptions] = await Promise.all([
          stripeGet<StripeBalance>(fetchImpl, secretKey, "/v1/balance"),
          stripeGet<{ data?: StripeSubscription[] }>(
            fetchImpl,
            secretKey,
            "/v1/subscriptions",
            { status: "all", limit: "100", "expand[]": "data.items.data.price" },
          ),
        ]);
        const subscriptionSummary = summarizeStripeSubscriptions(subscriptions.data ?? []);
        return {
          adapter: "Stripe",
          action,
          status: "completed",
          summary: [
            `Stripe snapshot read: active subscriptions: ${subscriptionSummary.activeCount}`,
            `MRR: ${formatMoneyMap(subscriptionSummary.mrrByCurrency)}`,
            `available balance: ${formatBalance(balance.available ?? [])}`,
            `pending balance: ${formatBalance(balance.pending ?? [])}`,
          ].join("; "),
        };
      } catch (error) {
        return failed(action, `Stripe read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async dryRun(action) {
      return {
        adapter: "Stripe",
        action,
        status: WRITE_ACTION_RE.test(action) ? "needs_approval" : "mocked",
        summary: "Stripe dry-run: Trent would read balance and subscription metrics without writing to Stripe.",
      };
    },
  };
}

export function summarizeStripeSubscriptions(subscriptions: StripeSubscription[]) {
  const activeStatuses = new Set(["active", "trialing", "past_due"]);
  const mrrByCurrency: Record<string, number> = {};
  let activeCount = 0;

  for (const subscription of subscriptions) {
    if (!activeStatuses.has(subscription.status ?? "")) continue;
    activeCount += 1;
    const currency = (subscription.currency ?? "usd").toLowerCase();
    for (const item of subscription.items?.data ?? []) {
      const unit = item.price?.unit_amount ?? 0;
      const quantity = item.quantity ?? 1;
      const interval = item.price?.recurring?.interval ?? "month";
      const monthly = interval === "year" ? Math.round((unit * quantity) / 12)
        : interval === "week" ? Math.round((unit * quantity * 52) / 12)
          : interval === "day" ? unit * quantity * 30
            : unit * quantity;
      mrrByCurrency[currency] = (mrrByCurrency[currency] ?? 0) + monthly;
    }
  }

  return { activeCount, mrrByCurrency };
}

function stripeSecret(env: EnvLike = process.env) {
  return env.STRIPE_SECRET_KEY?.trim() || undefined;
}

async function stripeGet<T>(fetchImpl: FetchLike, secretKey: string, path: string, query?: Record<string, string>) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  const response = await fetchImpl(`${STRIPE_BASE}${path}${qs}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function failed(action: string, summary: string): ToolCallRecord {
  return { adapter: "Stripe", action, status: "failed", summary };
}

function formatMoneyMap(values: Record<string, number>) {
  const entries = Object.entries(values);
  if (!entries.length) return "none";
  return entries.map(([currency, cents]) => `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`).join(", ");
}

function formatBalance(values: Array<{ amount?: number; currency?: string }>) {
  if (!values.length) return "none";
  return values
    .filter((item) => typeof item.amount === "number")
    .map((item) => `${(item.currency ?? "usd").toUpperCase()} ${((item.amount ?? 0) / 100).toFixed(2)}`)
    .join(", ") || "none";
}
