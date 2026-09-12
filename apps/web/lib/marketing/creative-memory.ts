import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { CreativePerformanceMemory, CreativePerformanceMemoryInput } from "./types";

export type CreativePerformanceObservation = {
  companyId: string;
  featureKey: string;
  outcome: string;
  campaignId: string;
};

export type CreativePerformanceLesson = {
  featureKey: string;
  outcome: string;
  sampleSize: number;
  contributingCompanies: number;
  privacyScope: "aggregate";
};

type CreativeMemoryStore = {
  createCreativePerformanceMemory(input: CreativePerformanceMemoryInput): Promise<CreativePerformanceMemory>;
  listCreativePerformanceMemories(featureKey: string): Promise<CreativePerformanceMemory[]>;
};

export type CreativeMemoryDeps = {
  store: CreativeMemoryStore;
  now: () => string;
};

export async function writeCreativePerformanceMemoryRecords(
  observations: CreativePerformanceObservation[],
  deps?: CreativeMemoryDeps
) {
  const memoryStore = deps?.store ?? requireCreativeMemoryStore();
  const timestamp = deps?.now() ?? nowIso();
  const records: CreativePerformanceMemory[] = [];

  for (const observation of observations) {
    records.push(await memoryStore.createCreativePerformanceMemory({
      companyId: observation.companyId,
      featureKey: observation.featureKey,
      outcome: observation.outcome,
      sampleSize: 1,
      sourceCampaignIds: [observation.campaignId],
      privacyScope: "company",
      validFrom: timestamp,
    }));
  }

  return records;
}

export async function getCreativePerformanceLessons(
  featureKey: string,
  options: { minCompanies: number; minSampleSize?: number },
  deps?: Pick<CreativeMemoryDeps, "store" | "now">
): Promise<CreativePerformanceLesson[]> {
  if (!Number.isInteger(options.minCompanies) || options.minCompanies <= 1) {
    throw new Error("minCompanies must be an integer greater than 1");
  }
  const minSampleSize = options.minSampleSize;
  if (minSampleSize === undefined || !Number.isInteger(minSampleSize) || minSampleSize <= 0) {
    throw new Error("minSampleSize must be a positive integer");
  }
  const memoryStore = deps?.store ?? requireCreativeMemoryStore();
  const now = deps?.now ? deps.now() : nowIso();
  const memories = (await memoryStore.listCreativePerformanceMemories(featureKey))
    .filter((memory) => isCreativeMemoryActive(memory, now));
  const byOutcome = new Map<string, CreativePerformanceMemory[]>();

  for (const memory of memories) {
    const items = byOutcome.get(memory.outcome) ?? [];
    items.push(memory);
    byOutcome.set(memory.outcome, items);
  }

  const lessons: CreativePerformanceLesson[] = [];
  for (const [outcome, records] of byOutcome) {
    const companies = new Set(records.map((record) => record.companyId));
    const sampleSize = records.reduce((sum, record) => sum + Math.max(0, record.sampleSize), 0);
    if (companies.size < options.minCompanies) continue;
    if (sampleSize < minSampleSize) continue;
    lessons.push({
      featureKey,
      outcome,
      sampleSize,
      contributingCompanies: companies.size,
      privacyScope: "aggregate",
    });
  }

  return lessons;
}

export function isCreativeMemoryActive(memory: Pick<CreativePerformanceMemory, "validFrom" | "validTo">, atIso = nowIso()) {
  const at = Date.parse(atIso);
  if (Date.parse(memory.validFrom) > at) return false;
  if (memory.validTo && Date.parse(memory.validTo) <= at) return false;
  return true;
}

function requireCreativeMemoryStore() {
  const memoryStore = store as typeof store & Partial<CreativeMemoryStore>;
  const requiredMethods = [
    "createCreativePerformanceMemory",
    "listCreativePerformanceMemories",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof memoryStore[method] !== "function") {
      throw new Error(`Creative memory store method is not available: ${method}`);
    }
  }
  return memoryStore as CreativeMemoryStore;
}
