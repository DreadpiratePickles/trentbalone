import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import { aggregatePrivatePatterns, type PrivateAggregateOptions } from "@/lib/cross-company-learning";

export type CapabilityPrivacyScope = "tenant" | "cross_company";

export type CapabilityMemoryRecord = {
  id?: string;
  companyId: string;
  subjectId: string;
  taskType: string;
  evalScore: number;
  costCents: number;
  latencyMs: number;
  outcome: "success" | "failure";
  privacyScope?: CapabilityPrivacyScope;
  createdAt?: string;
};

export type CapabilitySummary = Record<
  string,
  {
    subjectId: string;
    taskType: string;
    averageScore: number;
    successRate: number;
    averageCostCents: number;
    averageLatencyMs: number;
    sampleCount: number;
  }
>;

export function summarizeCapability(records: CapabilityMemoryRecord[]): CapabilitySummary {
  const groups = new Map<string, CapabilityMemoryRecord[]>();
  for (const record of records) {
    const key = `${record.subjectId}:${record.taskType}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return Object.fromEntries([...groups.entries()].map(([key, items]) => {
    const averageScore = avg(items.map((item) => item.evalScore));
    return [key, {
      subjectId: items[0].subjectId,
      taskType: items[0].taskType,
      averageScore,
      successRate: avg(items.map((item) => item.outcome === "success" ? 1 : 0)),
      averageCostCents: avg(items.map((item) => item.costCents)),
      averageLatencyMs: avg(items.map((item) => item.latencyMs)),
      sampleCount: items.length,
    }];
  }));
}

export function chooseBestCapability(candidates: string[], summary: CapabilitySummary, taskType: string) {
  return candidates
    .map((subjectId) => summary[`${subjectId}:${taskType}`])
    .filter(Boolean)
    .sort((a, b) => score(b) - score(a))[0]?.subjectId ?? candidates[0];
}

export async function persistCapabilityMemoryRecord(
  input: CapabilityMemoryRecord & { privacyScope: CapabilityPrivacyScope },
  deps?: {
    store?: Pick<typeof store, "createDocument">;
    now?: () => string;
  },
): Promise<CapabilityMemoryRecord & { id: string; privacyScope: CapabilityPrivacyScope; createdAt: string }> {
  const timestamp = deps?.now?.() ?? nowIso();
  const record = {
    ...input,
    id: input.id ?? makeId("capmem"),
    privacyScope: input.privacyScope,
    createdAt: input.createdAt ?? timestamp,
  };
  const targetStore = deps?.store ?? store;
  await targetStore.createDocument({
    companyId: record.companyId,
    type: "agent_note",
    title: `Capability memory: ${record.subjectId} ${record.taskType}`,
    content: JSON.stringify(record),
    source: "capability_memory",
    memoryTier: "semantic",
    validFrom: timestamp,
  });
  return record;
}

export function aggregateCapabilityOutcomePatterns(
  records: CapabilityMemoryRecord[],
  options: PrivateAggregateOptions,
) {
  return aggregatePrivatePatterns(
    records
      .filter((record) => record.privacyScope === "cross_company")
      .map((record) => ({
        companyId: record.companyId,
        pattern: `${record.subjectId}:${record.taskType}:${record.outcome}`,
        score: record.evalScore,
      })),
    options,
  );
}

function score(item: CapabilitySummary[string]) {
  return item.averageScore * 0.7 + item.successRate * 0.3 - Math.min(0.2, item.averageCostCents / 10000);
}

function avg(values: number[]) {
  return Math.round((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)) * 1000) / 1000;
}
