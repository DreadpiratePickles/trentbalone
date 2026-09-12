import { makeId } from "@/lib/utils";
import type { SupervisionRiskClass } from "./risk";

export type QueuedSupervisionAction = {
  id: string;
  action: string;
  riskClass: SupervisionRiskClass;
  requestedAt: string;
  eligibleAt: string;
  status: "ready" | "cooling_off";
};

export function buildQueuedAction(input: {
  action: string;
  riskClass: SupervisionRiskClass;
  requestedAt: string;
  defaultCoolingOffMinutes: number;
}): QueuedSupervisionAction {
  const needsCoolingOff = input.riskClass !== "reversible";
  const requestedAt = new Date(input.requestedAt);
  const eligibleAt = new Date(requestedAt);
  if (needsCoolingOff) eligibleAt.setUTCMinutes(eligibleAt.getUTCMinutes() + input.defaultCoolingOffMinutes);

  return {
    id: makeId("queue"),
    action: input.action,
    riskClass: input.riskClass,
    requestedAt: requestedAt.toISOString(),
    eligibleAt: eligibleAt.toISOString(),
    status: needsCoolingOff ? "cooling_off" : "ready",
  };
}
