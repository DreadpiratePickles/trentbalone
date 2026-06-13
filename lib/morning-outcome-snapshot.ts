import type { Approval, Company, UsageLedgerEntry } from "@/lib/types";
import { providerReadinessSnapshot } from "@/lib/provider-readiness";

export async function buildMorningOutcomeSnapshot(input: {
  company: Company;
  usage: UsageLedgerEntry[];
  approvals: Approval[];
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = input.env ?? process.env;
  const goals = await loadGoals(input.company.id);
  const activeGoals = goals.filter((goal) => goal.status === "active");
  const ledgerSpend = input.usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  const pendingApprovals = input.approvals.filter((approval) => approval.status === "pending").length;
  const readiness = providerReadinessSnapshot(env);
  const billing = readiness.find((item) => item.key === "billing");
  const analytics = readiness.find((item) => item.key === "analytics");

  return [
    "OUTCOME SNAPSHOT",
    `- users: ${input.company.metrics.users}`,
    `- signups: ${input.company.metrics.signups}`,
    `- revenue: ${money(input.company.metrics.revenueCents)}`,
    `- ledger spend: ${money(ledgerSpend)}`,
    `- pending approvals: ${pendingApprovals}`,
    `- goals: ${activeGoals.length} active${activeGoals.length ? ` (${activeGoals.map((goal) => goal.objective).slice(0, 3).join("; ")})` : ""}`,
    `- Stripe billing: ${statusLabel(billing?.status)}`,
    `- PostHog analytics: ${statusLabel(analytics?.status)}`,
    `- Sentry errors: ${env.SENTRY_AUTH_TOKEN || env.SENTRY_API_TOKEN ? "connected" : "not configured"}`,
  ];
}

type GoalLike = {
  objective: string;
  status: string;
};

async function loadGoals(companyId: string): Promise<GoalLike[]> {
  try {
    const { listGoals } = await import("@/lib/goal-store");
    return await listGoals(companyId);
  } catch {
    return [];
  }
}

function statusLabel(status: string | undefined) {
  if (status === "real") return "connected";
  if (status === "failed") return "failed";
  if (status === "approval_required") return "approval required";
  if (status === "test_only") return "test only";
  return "not configured";
}

function money(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
