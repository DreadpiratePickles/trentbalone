import { store } from "@/lib/store";
import type { OptimizationRun } from "@/lib/marketing/types";
import type { SocialAnalyticsSnapshot } from "@/lib/social/types";

export type AgentMissionAnalyticsContext = {
  socialSnapshots: SocialAnalyticsSnapshot[];
  adOptimizationRuns: OptimizationRun[];
  recommendations: string[];
};

export async function buildAgentMissionAnalyticsContext(companyId: string): Promise<AgentMissionAnalyticsContext> {
  const [socialSnapshots, adOptimizationRuns] = await Promise.all([
    store.listSocialAnalyticsSnapshots(companyId),
    store.listOptimizationRuns(companyId),
  ]);
  const recentSocial = socialSnapshots
    .slice()
    .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))
    .slice(0, 5);
  const recentAds = adOptimizationRuns
    .slice()
    .sort((a, b) => b.runDate.localeCompare(a.runDate))
    .slice(0, 5);
  return {
    socialSnapshots: recentSocial,
    adOptimizationRuns: recentAds,
    recommendations: extractRecommendations(recentSocial),
  };
}

export function formatAnalyticsContextForCeo(context: AgentMissionAnalyticsContext): string[] {
  if (context.socialSnapshots.length === 0 && context.adOptimizationRuns.length === 0) {
    return ["- no prior social analytics or ad optimization evidence recorded"];
  }
  return [
    ...context.socialSnapshots.map((snapshot) => {
      const report = snapshot.report;
      const parts = [
        `${title(snapshot.platform)} ${snapshot.periodStart.slice(0, 10)}-${snapshot.periodEnd.slice(0, 10)}`,
        reportText(report, "topFormat"),
        reportText(report, "winningHook"),
        reportText(report, "recommendation"),
      ].filter(Boolean);
      return `- ${parts.join("; ")}`;
    }),
    ...context.adOptimizationRuns.map((run) => {
      const decisions = Array.isArray(run.decisions)
        ? run.decisions.map(decisionLabel).filter(Boolean).join(", ")
        : decisionLabel(run.decisions);
      return `- Ads ${run.runDate}: ${run.status}; decisions: ${decisions || "none recorded"}`;
    }),
  ];
}

function extractRecommendations(snapshots: SocialAnalyticsSnapshot[]) {
  return snapshots
    .map((snapshot) => snapshot.report.recommendation)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function reportText(report: Record<string, unknown>, key: string) {
  const value = report[key];
  return typeof value === "string" && value.trim() ? `${key}: ${value}` : "";
}

function decisionLabel(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : "";
  const reason = typeof record.reason === "string" ? record.reason : "";
  return [action, reason].filter(Boolean).join(" - ");
}

function title(value: string) {
  return value === "x" ? "X" : value[0]?.toUpperCase() + value.slice(1);
}
