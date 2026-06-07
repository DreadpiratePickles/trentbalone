import { makeId, nowIso } from "@/lib/utils";
import type { RollbackDescriptor } from "./plan-card";
import type { SupervisionRiskClass } from "./risk";

export type ActionLedgerEntry = {
  id: string;
  companyId: string;
  action: string;
  objectId: string;
  createdAt: string;
  riskClass: SupervisionRiskClass;
  rollback?: RollbackDescriptor;
};

export type RollbackPlan = {
  windowMinutes: number;
  createdAt: string;
  steps: Array<{
    actionId: string;
    action: string;
    objectId: string;
    rollbackKind: RollbackDescriptor["kind"];
    rollback: RollbackDescriptor;
  }>;
  excluded: Array<{
    actionId: string;
    reason: "outside_window" | "irreversible" | "missing_rollback";
  }>;
};

export function recordActionLedgerEntry(input: Omit<ActionLedgerEntry, "id"> & { id?: string }): ActionLedgerEntry {
  return {
    id: input.id ?? makeId("action"),
    companyId: input.companyId,
    action: input.action,
    objectId: input.objectId,
    createdAt: input.createdAt,
    riskClass: input.riskClass,
    rollback: input.rollback,
  };
}

export function createRollbackPlanForWindow(input: {
  entries: ActionLedgerEntry[];
  now?: string;
  windowMinutes: number;
}): RollbackPlan {
  const now = input.now ?? nowIso();
  const floor = Date.parse(now) - input.windowMinutes * 60 * 1000;
  const steps: RollbackPlan["steps"] = [];
  const excluded: RollbackPlan["excluded"] = [];

  for (const entry of input.entries) {
    if (Date.parse(entry.createdAt) < floor) {
      continue;
    }
    if (entry.riskClass === "irreversible") {
      excluded.push({ actionId: entry.id, reason: "irreversible" });
      continue;
    }
    if (!entry.rollback) {
      excluded.push({ actionId: entry.id, reason: "missing_rollback" });
      continue;
    }
    steps.push({
      actionId: entry.id,
      action: entry.action,
      objectId: entry.objectId,
      rollbackKind: entry.rollback.kind,
      rollback: entry.rollback,
    });
  }

  return {
    windowMinutes: input.windowMinutes,
    createdAt: now,
    steps: steps.reverse(),
    excluded,
  };
}
