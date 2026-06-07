import { makeId, nowIso } from "@/lib/utils";

export type DecisionProvenance = {
  id: string;
  companyId: string;
  memoryKey: string;
  sourceActionId: string;
  sourceSummary: string;
  actorId: string;
  trace: string[];
  createdAt: string;
};

export function createDecisionProvenance(input: {
  companyId: string;
  memoryKey: string;
  sourceActionId: string;
  sourceSummary: string;
  actorId: string;
}): DecisionProvenance {
  return {
    id: makeId("prov"),
    companyId: input.companyId,
    memoryKey: input.memoryKey,
    sourceActionId: input.sourceActionId,
    sourceSummary: input.sourceSummary,
    actorId: input.actorId,
    trace: [input.sourceActionId, input.memoryKey],
    createdAt: nowIso(),
  };
}
