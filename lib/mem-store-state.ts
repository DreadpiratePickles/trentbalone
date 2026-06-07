import { AppState } from "@/lib/types";
import { createSeedState } from "@/lib/seed";
import { makeId, nowIso } from "@/lib/utils";
import { computeAuditHash } from "@/lib/audit-log";

declare global {
  // eslint-disable-next-line no-var
  var __trentState: AppState | undefined;
}

export function state(): AppState {
  if (!globalThis.__trentState) {
    globalThis.__trentState = createSeedState();
  }
  return globalThis.__trentState;
}

export function addAuditLog(
  companyId: string,
  actor: "system" | "user" | "agent",
  action: string,
  objectType: string,
  objectId: string,
  summary: string
) {
  const id = makeId("audit");
  const createdAt = nowIso();
  const companyLogs = state().auditLogs.filter((l) => l.companyId === companyId);
  const prevHash = companyLogs.length > 0
    ? companyLogs[companyLogs.length - 1].hash
    : "genesis";
  const hash = computeAuditHash(prevHash, id, actor, action, objectId, summary, createdAt);
  state().auditLogs.push({
    id,
    companyId,
    actor,
    action,
    objectType,
    objectId,
    summary,
    createdAt,
    hash,
    prevHash,
  });
}
