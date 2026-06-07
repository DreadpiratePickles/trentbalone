import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { buildQueuedAction, type QueuedSupervisionAction } from "./action-queue";
import { recordActionLedgerEntry, type ActionLedgerEntry } from "./action-ledger";
import type { RollbackDescriptor } from "./plan-card";
import type { SupervisionRiskClass } from "./risk";

type PersistedQueueMetadata = {
  kind: "action_queue";
  action: QueuedSupervisionAction;
  approvalId?: string;
  payload: Record<string, unknown>;
};

type PersistedLedgerMetadata = {
  kind: "action_ledger";
  entry: ActionLedgerEntry;
  result: Record<string, unknown>;
};

export async function persistSupervisionQueuedAction(input: {
  companyId: string;
  action: string;
  riskClass: SupervisionRiskClass;
  requestedAt?: string;
  defaultCoolingOffMinutes: number;
  approvalId?: string;
  payload?: Record<string, unknown>;
}) {
  const action = buildQueuedAction({
    action: input.action,
    riskClass: input.riskClass,
    requestedAt: input.requestedAt ?? nowIso(),
    defaultCoolingOffMinutes: input.defaultCoolingOffMinutes,
  });
  const metadata: PersistedQueueMetadata = {
    kind: "action_queue",
    action,
    approvalId: input.approvalId,
    payload: input.payload ?? {},
  };
  const jobRun = await store.createJobRun({
    type: "supervision_action",
    status: "running",
    companyId: input.companyId,
    trigger: "system",
    summary: `Queued supervision action: ${input.action}`,
    resultCount: 0,
    metadata,
  });

  return { action, jobRun };
}

export async function listQueuedSupervisionActions(companyId: string): Promise<QueuedSupervisionAction[]> {
  const jobs = await store.listJobRuns(companyId);
  return jobs
    .filter((job) => job.type === "supervision_action" && job.status === "running")
    .map((job) => parseQueueMetadata(job.metadata)?.action)
    .filter((action): action is QueuedSupervisionAction => Boolean(action));
}

export async function persistSupervisionActionLedgerEntry(input: {
  companyId: string;
  action: string;
  objectId: string;
  createdAt?: string;
  riskClass: SupervisionRiskClass;
  rollback?: RollbackDescriptor;
  result?: Record<string, unknown>;
}) {
  const entry = recordActionLedgerEntry({
    companyId: input.companyId,
    action: input.action,
    objectId: input.objectId,
    createdAt: input.createdAt ?? nowIso(),
    riskClass: input.riskClass,
    rollback: input.rollback,
  });
  const metadata: PersistedLedgerMetadata = {
    kind: "action_ledger",
    entry,
    result: input.result ?? {},
  };
  const jobRun = await store.createJobRun({
    type: "supervision_action",
    status: "completed",
    companyId: input.companyId,
    trigger: "system",
    completedAt: nowIso(),
    summary: `Executed supervision action: ${input.action}`,
    resultCount: 1,
    metadata,
  });
  await store.addAudit(
    input.companyId,
    "agent",
    "supervision.action.executed",
    "supervision_action",
    entry.id,
    input.action,
  );

  return { entry, jobRun };
}

export async function listPersistedSupervisionLedger(companyId: string): Promise<ActionLedgerEntry[]> {
  const jobs = await store.listJobRuns(companyId);
  return jobs
    .filter((job) => job.type === "supervision_action" && job.status === "completed")
    .map((job) => parseLedgerMetadata(job.metadata)?.entry)
    .filter((entry): entry is ActionLedgerEntry => Boolean(entry));
}

function parseQueueMetadata(metadata: Record<string, unknown>): PersistedQueueMetadata | undefined {
  if (metadata.kind !== "action_queue") return undefined;
  if (!metadata.action || typeof metadata.action !== "object") return undefined;
  return metadata as PersistedQueueMetadata;
}

function parseLedgerMetadata(metadata: Record<string, unknown>): PersistedLedgerMetadata | undefined {
  if (metadata.kind !== "action_ledger") return undefined;
  if (!metadata.entry || typeof metadata.entry !== "object") return undefined;
  return metadata as PersistedLedgerMetadata;
}
