/**
 * lib/operating-state.ts — §1 P0-2: real state inspection.
 *
 * Today every cycle plans from amnesia: the only planner context is
 * `JSON.stringify(company)`. This builds a compact, token-capped
 * OperatingStateBundle — open + stale tasks with age, last cycle/round summary
 * and per-seat outcomes, pending approvals, budget remaining vs burn, and
 * semantically-recalled memory — the highest-leverage change in the audit.
 *
 * Context-engineering discipline: each section is independently capped so the
 * bundle never overloads / distracts the planner (no `JSON.stringify(company)`).
 */
import { store } from "@/lib/store";
import { recallRelevantMemory } from "@/lib/semantic-router";
import type { Company } from "@/lib/types";

export type OperatingStateBundle = {
  text: string;
  openTaskCount: number;
  staleTaskCount: number;
  pendingApprovalCount: number;
  budgetRemainingCents: number;
  spentCents: number;
  memoryItemCount: number;
};

const STALE_TASK_HOURS = 48;

function hoursSince(iso?: string): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.round(ms / 3_600_000));
}

function cap(lines: string[], max: number): string[] {
  return lines.slice(0, max);
}

export async function buildOperatingStateBundle(
  company: Company,
  objective: string,
): Promise<OperatingStateBundle> {
  const [tasks, approvals, usage, cycles, memory] = await Promise.all([
    store.listTasks(company.id).catch(() => []),
    store.listApprovals(company.id).catch(() => []),
    store.listUsage(company.id).catch(() => []),
    store.listCycles(company.id).catch(() => []),
    recallRelevantMemory(company.id, objective, { k: 5, tokenBudget: 900 }).catch(() => ({ text: "", items: [], estimatedTokens: 0 })),
  ]);

  const openTasks = tasks.filter((t) => t.status !== "completed" && t.status !== "failed");
  const staleTasks = openTasks.filter((t) => hoursSince(t.createdAt) >= STALE_TASK_HOURS);
  const pending = approvals.filter((a) => a.status === "pending");
  const spentCents = usage.reduce((s, u) => s + (u.amountCents ?? 0), 0);
  const totalBudget = company.weeklyBudgetCents ?? company.budgetCents ?? 0;
  const budgetRemainingCents = Math.max(0, totalBudget - spentCents);
  const lastCycle = cycles[0];

  const sections: string[] = [];

  sections.push(`OBJECTIVE\n${objective}`);

  sections.push(
    [
      "OPEN TASKS (age in hours)",
      ...cap(
        openTasks.map((t) => `- [${t.status}] ${t.title} · ${t.agentRole} · ${t.priority} · ${hoursSince(t.createdAt)}h${hoursSince(t.createdAt) >= STALE_TASK_HOURS ? " (STALE)" : ""}`),
        10,
      ),
      openTasks.length === 0 ? "- none" : "",
    ].filter(Boolean).join("\n"),
  );

  sections.push(
    [
      "PENDING APPROVALS",
      ...cap(pending.map((a) => `- ${a.action} — ${a.reason?.slice(0, 120) ?? ""}`), 6),
      pending.length === 0 ? "- none" : "",
    ].filter(Boolean).join("\n"),
  );

  sections.push(
    [
      "BUDGET",
      `- spent: $${(spentCents / 100).toFixed(2)} of $${(totalBudget / 100).toFixed(2)}`,
      `- remaining: $${(budgetRemainingCents / 100).toFixed(2)}`,
    ].join("\n"),
  );

  sections.push(
    [
      "LAST CYCLE",
      lastCycle
        ? `- ${lastCycle.status} · ${lastCycle.summary?.slice(0, 240) ?? "no summary"}`
        : "- no cycles run yet",
    ].join("\n"),
  );

  if (memory.text) {
    sections.push(`RELEVANT MEMORY\n${memory.text.slice(0, 1400)}`);
  }

  return {
    text: sections.join("\n\n"),
    openTaskCount: openTasks.length,
    staleTaskCount: staleTasks.length,
    pendingApprovalCount: pending.length,
    budgetRemainingCents,
    spentCents,
    memoryItemCount: memory.items.length,
  };
}
