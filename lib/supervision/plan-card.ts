import { makeId, nowIso } from "@/lib/utils";
import { rateActionRisk, type ActionRiskRating, type SupervisionSideEffect } from "./risk";

export type RollbackDescriptor = {
  kind: "restore" | "set_budget" | "revoke" | "redeploy" | "custom";
  targetId: string;
  previousValue?: unknown;
  instructions?: string;
};

export type DryRunPreview = {
  summary: string;
  operations: string[];
};

export type PreActionPlanCardInput = {
  companyId: string;
  actorId: string;
  action: string;
  objectType: string;
  objectId: string;
  reason: string;
  estimatedCostCents: number;
  sideEffects?: SupervisionSideEffect[];
  rollback?: RollbackDescriptor;
  dryRun: DryRunPreview;
};

export type PreActionPlanCard = {
  id: string;
  companyId: string;
  actorId: string;
  status: "plan_only";
  what: string;
  why: string;
  action: string;
  objectType: string;
  objectId: string;
  costForecast: {
    estimatedCents: number;
    display: string;
  };
  risk: ActionRiskRating;
  rollback?: RollbackDescriptor;
  dryRun: DryRunPreview;
  executionAllowed: false;
  createdAt: string;
};

export function createPreActionPlanCard(input: PreActionPlanCardInput): PreActionPlanCard {
  const risk = rateActionRisk({
    sideEffects: input.sideEffects,
    hasRollback: Boolean(input.rollback),
  });

  return {
    id: makeId("plancard"),
    companyId: input.companyId,
    actorId: input.actorId,
    status: "plan_only",
    what: `${input.action} on ${input.objectType} ${input.objectId}`,
    why: input.reason,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    costForecast: {
      estimatedCents: input.estimatedCostCents,
      display: formatCents(input.estimatedCostCents),
    },
    risk,
    rollback: input.rollback,
    dryRun: input.dryRun,
    executionAllowed: false,
    createdAt: nowIso(),
  };
}

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}
