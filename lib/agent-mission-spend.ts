import { isPlatformActionLiveMode } from "@/lib/platform-action-mode";
import { assertSpendAvailable, assertToolSpendAllowed } from "@/lib/spend";
import { store } from "@/lib/store";

export async function assertAgentMissionBudget(companyId: string, budgetCents: number): Promise<void> {
  if (budgetCents <= 0) return;
  await assertSpendAvailable(companyId, budgetCents, `Agent mission budget (${budgetCents}c)`);
}

export async function reserveAgentMissionPaidSpend(
  companyId: string,
  dailyBudgetCents: number,
  campaignId: string,
): Promise<void> {
  if (dailyBudgetCents <= 0) return;
  await assertToolSpendAllowed(companyId, "agent_mission.ads.launch", dailyBudgetCents);
}

export async function reconcileAgentMissionPaidSpend(input: {
  companyId: string;
  dailyBudgetCents: number;
  campaignId: string;
  externalRef: string;
}): Promise<void> {
  if (input.dailyBudgetCents <= 0) return;
  const actualCents = isPlatformActionLiveMode() ? input.dailyBudgetCents : 0;
  await store.addUsage({
    companyId: input.companyId,
    category: "ads",
    description: `[final] agent_mission.ads.launch ${input.campaignId}`,
    amountCents: 0,
    metadata: {
      tool: "agent_mission.ads.launch",
      isFinalCharge: true,
      reservedCents: input.dailyBudgetCents,
      actualCents,
      externalRef: input.externalRef,
      simulated: !isPlatformActionLiveMode(),
    },
  });
}
