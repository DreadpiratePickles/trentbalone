import type { CompanyBrief, CompanyInput, CompanyMetrics, CycleFrequency, RecurringTaskTemplate } from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";

export function nextCycleAtForFrequency(frequency: CycleFrequency, fromIso = nowIso()): string | undefined {
  if (frequency === "manual") return undefined;
  const date = new Date(fromIso);
  date.setDate(date.getDate() + (frequency === "daily" ? 1 : 7));
  return date.toISOString();
}

export function buildDefaultBrief(input: Partial<CompanyBrief> = {}): CompanyBrief {
  return {
    vision: input.vision ?? "",
    icp: input.icp ?? "",
    offer: input.offer ?? "",
    pricing: input.pricing ?? "",
    competitors: input.competitors ?? "",
    brandVoice: input.brandVoice ?? "Clear, confident, useful.",
    goals: input.goals ?? "",
    constraints:
      input.constraints ??
      "Require approval for spend, public posting, email sending, deletion, billing, and code merges.",
    successMetrics: input.successMetrics ?? "Completed cycles, approved tasks, reports, cost per task, revenue."
  };
}

export function buildDefaultMetrics(): CompanyMetrics {
  return { users: 0, signups: 0, revenueCents: 0, conversionRate: 0, retentionRate: 0 };
}

export function buildCompanyInput(input: CompanyInput) {
  const brief = buildDefaultBrief(input.brief);
  const metrics = buildDefaultMetrics();
  return { brief, metrics };
}

export function buildDefaultRecurringTasks(companyId: string, createdAt: string): RecurringTaskTemplate[] {
  const tomorrow = nextCycleAtForFrequency("daily", createdAt) as string;
  const nextWeek = nextCycleAtForFrequency("weekly", createdAt) as string;
  return [
    {
      id: makeId("recurring"),
      companyId,
      title: "Daily growth and customer signal sweep",
      prompt:
        "Review metrics, support themes, public mentions, and campaign opportunities. Create follow-up tasks, but do not send or publish externally.",
      agentRole: "growth",
      priority: "medium",
      tags: ["growth", "daily-cycle"],
      cadence: "daily",
      enabled: true,
      nextRunAt: tomorrow,
      createdAt
    },
    {
      id: makeId("recurring"),
      companyId,
      title: "Weekly operating report",
      prompt:
        "Summarize cycles, tasks, approvals, costs, product progress, growth learnings, and recommended next actions.",
      agentRole: "analyst",
      priority: "high",
      tags: ["weekly-report", "analytics"],
      cadence: "weekly",
      enabled: true,
      nextRunAt: nextWeek,
      createdAt
    }
  ];
}
