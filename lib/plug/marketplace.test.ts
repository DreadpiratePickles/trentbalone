import { describe, expect, it } from "vitest";
import { composePlugs } from "@/lib/plug/composition";
import { runPlugEval } from "@/lib/plug/eval-runner";
import { forkPlug } from "@/lib/plug/forking";
import { listLaunchPlugs, matchPlugsForIntent } from "@/lib/plug/registry";
import { rankPlugs, selectBanditWinner } from "@/lib/plug/ranking";
import { planCreatorRevenueShare } from "@/lib/plug/revenue-share";
import { reviewPlugSecurity } from "@/lib/plug/security-review";
import { recordPlugRunTelemetry } from "@/lib/plug/telemetry";
import { isBreakingPlugChange, pinPlugVersion } from "@/lib/plug/versioning";

describe("Plug marketplace primitives", () => {
  it("ships 20+ launch plugs and ranks by measured outcome", () => {
    const plugs = listLaunchPlugs();
    expect(plugs.length).toBeGreaterThanOrEqual(20);
    expect(plugs.every((plug) => plug.capabilityScore !== null)).toBe(true);
    expect(matchPlugsForIntent("weekly ops review for b2b saas", plugs)[0].slug).toBe("weekly-ops-review");
    expect(rankPlugs(plugs)[0].marketplaceScore).toBeGreaterThan(rankPlugs(plugs).at(-1)?.marketplaceScore ?? 1);
  });

  it("supports evals, versioning, security review, composition, telemetry, revenue share, and forks", async () => {
    const [a, b] = listLaunchPlugs();
    await expect(runPlugEval(a)).resolves.toMatchObject({ subjectType: "plug", subjectId: a.id });
    expect(isBreakingPlugChange(a, { ...a, declaredTools: [...a.declaredTools, { toolId: "stripe", allowedActions: ["charge"], approvalRequiredActions: ["charge"] }] })).toBe(true);
    expect(pinPlugVersion(a, "co_1")).toMatchObject({ companyId: "co_1", plugId: a.id, version: a.version });
    expect(reviewPlugSecurity(a).status).toBe("approved");
    expect(composePlugs([a, b], { maxDepth: 3, budgetCents: 1000 }).handoffs[0].fromPlugId).toBe(a.id);
    expect(selectBanditWinner([{ id: a.id, reward: 0.8, pulls: 10 }, { id: b.id, reward: 0.6, pulls: 10 }])).toBe(a.id);
    expect(recordPlugRunTelemetry([], { plugId: a.id, companyId: "co_1", success: true, costCents: 10, durationMs: 1000, failureTags: [] })).toHaveLength(1);
    expect(planCreatorRevenueShare({ grossCents: 10000, platformFeeBps: 2000, stripeFeeCents: 350 })).toMatchObject({ creatorGrossCents: 7650 });
    expect(forkPlug(a, { newId: "plug_private", ownerCompanyId: "co_1" })).toMatchObject({ id: "plug_private", visibility: { scope: "private", companyId: "co_1" } });
  });
});
