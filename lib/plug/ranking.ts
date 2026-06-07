import type { PlugDefinition } from "@/lib/plug/schema-v2";

export type RankedPlug = PlugDefinition & { marketplaceScore: number };

export function rankPlugs(plugs: PlugDefinition[]): RankedPlug[] {
  return plugs
    .filter(hasMeasuredOutcomes)
    .map((plug) => ({
      ...plug,
      marketplaceScore: round(plug.capabilityScore * 0.6 + plug.completionRate * 0.3 - Math.min(0.2, plug.costPerRunCents / 2000)),
    }))
    .sort((a, b) => b.marketplaceScore - a.marketplaceScore);
}

export function selectBanditWinner(arms: Array<{ id: string; reward: number; pulls: number }>) {
  return arms
    .map((arm) => ({ ...arm, ucb: arm.reward + Math.sqrt(2 * Math.log(totalPulls(arms) + 1) / Math.max(1, arm.pulls)) }))
    .sort((a, b) => b.ucb - a.ucb)[0].id;
}

function totalPulls(arms: Array<{ pulls: number }>) {
  return arms.reduce((sum, arm) => sum + arm.pulls, 0);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function hasMeasuredOutcomes(plug: PlugDefinition) {
  return Number.isFinite(plug.capabilityScore)
    && Number.isFinite(plug.completionRate)
    && Number.isFinite(plug.evalSet.lastScore)
    && Number.isFinite(plug.costPerRunCents);
}
