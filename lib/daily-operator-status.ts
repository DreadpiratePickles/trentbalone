import type { Company } from "@/lib/types";

export type DailyOperatorStatus = {
  enabled: boolean;
  label: "manual only" | "nightly durable operator";
  nextRunAt?: string;
  lastRunAt?: string;
  morningEmail: string;
  approvalQueue: string;
};

export function buildDailyOperatorStatus(company: Company, nowIso = new Date().toISOString()): DailyOperatorStatus {
  if (company.nightlyRunHour == null) {
    return {
      enabled: false,
      label: "manual only",
      nextRunAt: undefined,
      lastRunAt: company.lastCycleAt,
      morningEmail: "not scheduled",
      approvalQueue: "manual runs only",
    };
  }

  return {
    enabled: true,
    label: "nightly durable operator",
    lastRunAt: company.lastCycleAt,
    nextRunAt: nextNightlyAt(company.nightlyRunHour, nowIso),
    morningEmail: "assembled after the nightly cycle",
    approvalQueue: "risky actions become founder approvals",
  };
}

function nextNightlyAt(hour: number, nowIso: string): string {
  const now = new Date(nowIso);
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
