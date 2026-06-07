import { describe, expect, it } from "vitest";
import { createPreActionPlanCard } from "./plan-card";
import { rateActionRisk } from "./risk";

describe("supervision plan cards", () => {
  it("surfaces what, why, cost, risk, reversibility, and dry-run preview before execution", () => {
    const card = createPreActionPlanCard({
      companyId: "co_1",
      actorId: "agent_growth",
      action: "meta.campaign.scale_budget",
      objectType: "ad_campaign",
      objectId: "campaign_1",
      reason: "Winning creative is below target CAC",
      estimatedCostCents: 12500,
      sideEffects: ["spends_money", "external_api_call"],
      rollback: { kind: "set_budget", targetId: "campaign_1", previousValue: { dailyBudgetCents: 2500 } },
      dryRun: {
        summary: "Would raise daily Meta budget to $125.",
        operations: ["validate approval", "reserve spend", "call Meta budget endpoint"],
      },
    });

    expect(card.status).toBe("plan_only");
    expect(card.what).toContain("meta.campaign.scale_budget");
    expect(card.why).toBe("Winning creative is below target CAC");
    expect(card.costForecast.estimatedCents).toBe(12500);
    expect(card.risk.riskClass).toBe("costly");
    expect(card.risk.reversibility).toBe("costly_to_reverse");
    expect(card.dryRun.operations).toContain("call Meta budget endpoint");
    expect(card.executionAllowed).toBe(false);
  });

  it("rates irreversible actions above costly reversible actions", () => {
    expect(rateActionRisk({ sideEffects: ["delete_data"], hasRollback: false }).riskClass).toBe("irreversible");
    expect(rateActionRisk({ sideEffects: ["spends_money"], hasRollback: true }).riskClass).toBe("costly");
    expect(rateActionRisk({ sideEffects: ["internal_state_change"], hasRollback: true }).riskClass).toBe("reversible");
  });
});
