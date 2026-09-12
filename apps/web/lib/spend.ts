import { store } from "@/lib/store";
import type { AgentRole, UsageLedgerEntry } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export class SpendCapExceededError extends Error {
  constructor(
    message: string,
    readonly budgetCents: number,
    readonly spentCents: number,
    readonly requestedCents: number
  ) {
    super(message);
    this.name = "SpendCapExceededError";
  }
}

export class AgentTokenBudgetExceededError extends Error {
  constructor(
    readonly role: AgentRole,
    readonly dailyBudget: number,
    readonly todayUsed: number
  ) {
    super(`${role} agent has hit its daily token budget (${dailyBudget.toLocaleString()} tokens).`);
    this.name = "AgentTokenBudgetExceededError";
  }
}

export async function getSpendSummary(companyId: string) {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error("Company not found");

  const usage = await store.listUsage(company.id);
  const spentCents = usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  const byCategory = usage.reduce<Record<UsageLedgerEntry["category"], number>>(
    (totals, entry) => {
      totals[entry.category] += entry.amountCents;
      return totals;
    },
    { llm: 0, browser: 0, infra: 0, ads: 0, credits: 0, media: 0 }
  );

  const percentUsed = company.budgetCents > 0
    ? Math.min(100, Math.round((spentCents / company.budgetCents) * 100))
    : 100;

  // Weekly spend (rolling 7-day window)
  const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weeklySpentCents = usage
    .filter((e) => e.createdAt >= weekAgoIso)
    .reduce((sum, e) => sum + e.amountCents, 0);
  const weeklyBudgetCents = company.weeklyBudgetCents ?? 0;
  const weeklyPercentUsed = weeklyBudgetCents > 0
    ? Math.min(100, Math.round((weeklySpentCents / weeklyBudgetCents) * 100))
    : 0;

  return {
    companyId: company.id,
    budgetCents: company.budgetCents,
    spentCents,
    remainingCents: Math.max(0, company.budgetCents - spentCents),
    percentUsed,
    /** Soft warn at 80% — surface in UI, still allow */
    softWarn: percentUsed >= 80 && percentUsed < 100,
    /** Hard stop at 100% — assertSpendAvailable will throw */
    hardStop: percentUsed >= 100,
    byCategory,
    // Weekly budget tracking
    weeklyBudgetCents,
    weeklySpentCents,
    weeklyPercentUsed,
    weeklySoftWarn: weeklyBudgetCents > 0 && weeklyPercentUsed >= 80 && weeklyPercentUsed < 100,
    weeklyHardStop: weeklyBudgetCents > 0 && weeklyPercentUsed >= 100,
  };
}

export async function assertSpendAvailable(
  companyId: string,
  requestedCents: number,
  description: string
) {
  if (requestedCents <= 0) return getSpendSummary(companyId);

  const summary = await getSpendSummary(companyId);
  if (summary.budgetCents <= 0 || summary.spentCents + requestedCents > summary.budgetCents) {
    throw new SpendCapExceededError(
      `${description} would exceed the company monthly spend cap.`,
      summary.budgetCents,
      summary.spentCents,
      requestedCents
    );
  }
  if (summary.weeklyBudgetCents > 0 && summary.weeklySpentCents + requestedCents > summary.weeklyBudgetCents) {
    throw new SpendCapExceededError(
      `${description} would exceed the company weekly spend cap.`,
      summary.weeklyBudgetCents,
      summary.weeklySpentCents,
      requestedCents
    );
  }
  return summary;
}

/**
 * Pre-flight: check per-agent daily token budget before execution.
 * Tokens are estimated from recent executions for the same role today.
 * Throws AgentTokenBudgetExceededError if the agent is over budget.
 */
export async function assertAgentTokenBudget(
  companyId: string,
  role: AgentRole,
  estimatedTokens: number
): Promise<void> {
  const agents = await store.listAgents(companyId);
  const agent = agents.find((a) => a.role === role);
  if (!agent?.dailyTokenBudget || agent.dailyTokenBudget <= 0) return; // unlimited

  // Sum tokens used by this role today (UTC day)
  const executions = await store.listExecutions(companyId);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const todayUsed = executions
    .filter((e) => e.agentRole === role && e.createdAt >= todayIso)
    .reduce((sum, e) => sum + (e.tokens ?? 0), 0);

  if (todayUsed + estimatedTokens > agent.dailyTokenBudget) {
    throw new AgentTokenBudgetExceededError(role, agent.dailyTokenBudget, todayUsed);
  }
}

/**
 * Pre-flight for SPENDS_MONEY tool actions.
 * Call before any tool that results in real external spend (ads, email sends, etc.).
 */
export async function assertToolSpendAllowed(
  companyId: string,
  toolName: string,
  estimatedCents: number
): Promise<void> {
  if (estimatedCents <= 0) return;
  await assertSpendAvailable(
    companyId,
    estimatedCents,
    `Tool "${toolName}" (SPENDS_MONEY)`
  );
  // Reserve the estimated spend now so concurrent calls see it in the running total.
  // The caller must write a final entry with the actual amount on completion and
  // cancel this reservation (amountCents = 0) if the tool ultimately costs less.
  await store.addUsage({
    companyId,
    category: "llm",
    description: `[reservation] ${toolName}`,
    amountCents: estimatedCents,
    metadata: { tool: toolName, isReservation: true, reservedAt: nowIso() }
  });
}
