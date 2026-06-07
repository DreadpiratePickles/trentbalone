import { describe, expect, it, vi } from "vitest";
import {
  getCreativePerformanceLessons,
  writeCreativePerformanceMemoryRecords,
} from "./creative-memory";
import type { CreativePerformanceMemory } from "./types";

describe("creative performance memory", () => {
  it("writes only privacy-safe per-company records without crossing tenant source data", async () => {
    const deps = memoryDeps();

    await writeCreativePerformanceMemoryRecords([
      {
        companyId: "co_1",
        featureKey: "headline:urgency",
        outcome: "winner",
        campaignId: "camp_1",
      },
      {
        companyId: "co_2",
        featureKey: "headline:urgency",
        outcome: "winner",
        campaignId: "camp_2",
      },
    ], deps);

    expect(deps.store.createCreativePerformanceMemory).toHaveBeenCalledTimes(2);
    expect(deps.store.createCreativePerformanceMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      companyId: "co_1",
      sourceCampaignIds: ["camp_1"],
      privacyScope: "company",
      sampleSize: 1,
    }));
    expect(deps.store.createCreativePerformanceMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      companyId: "co_2",
      sourceCampaignIds: ["camp_2"],
      privacyScope: "company",
      sampleSize: 1,
    }));
  });

  it("does not surface lessons below the k-anonymity company threshold", async () => {
    const deps = memoryDeps({
      memories: [
        memory({ id: "m1", companyId: "co_1", outcome: "winner", sourceCampaignIds: ["camp_1"] }),
        memory({ id: "m2", companyId: "co_2", outcome: "winner", sourceCampaignIds: ["camp_2"] }),
      ],
    });

    const lessons = await getCreativePerformanceLessons("headline:urgency", {
      minCompanies: 3,
      minSampleSize: 3,
    }, deps);

    expect(lessons).toEqual([]);
  });

  it("does not surface lessons below the configured sample-size threshold", async () => {
    const deps = memoryDeps({
      memories: [
        memory({ id: "m1", companyId: "co_1", outcome: "winner", sampleSize: 2, sourceCampaignIds: ["camp_1"] }),
        memory({ id: "m2", companyId: "co_2", outcome: "winner", sampleSize: 2, sourceCampaignIds: ["camp_2"] }),
        memory({ id: "m3", companyId: "co_3", outcome: "winner", sampleSize: 1, sourceCampaignIds: ["camp_3"] }),
      ],
    });

    const lessons = await getCreativePerformanceLessons("headline:urgency", {
      minCompanies: 3,
      minSampleSize: 6,
    }, deps);

    expect(lessons).toEqual([]);
  });

  it("surfaces aggregate lessons only after enough distinct companies contribute", async () => {
    const deps = memoryDeps({
      memories: [
        memory({ id: "m1", companyId: "co_1", outcome: "winner", sourceCampaignIds: ["camp_1"] }),
        memory({ id: "m2", companyId: "co_2", outcome: "winner", sourceCampaignIds: ["camp_2"] }),
        memory({ id: "m3", companyId: "co_3", outcome: "winner", sourceCampaignIds: ["camp_3"] }),
      ],
    });

    const lessons = await getCreativePerformanceLessons("headline:urgency", {
      minCompanies: 3,
      minSampleSize: 3,
    }, deps);

    expect(lessons).toEqual([{
      featureKey: "headline:urgency",
      outcome: "winner",
      sampleSize: 3,
      contributingCompanies: 3,
      privacyScope: "aggregate",
    }]);
    expect(JSON.stringify(lessons)).not.toContain("co_1");
    expect(JSON.stringify(lessons)).not.toContain("camp_1");
  });

  it("requires an explicit sample-size threshold before surfacing lessons", async () => {
    const deps = memoryDeps({
      memories: [
        memory({ id: "m1", companyId: "co_1", outcome: "winner", sourceCampaignIds: ["camp_1"] }),
        memory({ id: "m2", companyId: "co_2", outcome: "winner", sourceCampaignIds: ["camp_2"] }),
        memory({ id: "m3", companyId: "co_3", outcome: "winner", sourceCampaignIds: ["camp_3"] }),
      ],
    });

    await expect(getCreativePerformanceLessons("headline:urgency", { minCompanies: 3 }, deps)).rejects.toThrow(
      "minSampleSize must be a positive integer"
    );
  });

  it("ignores expired and not-yet-valid memory records", async () => {
    const deps = memoryDeps({
      memories: [
        memory({ id: "m1", companyId: "co_1", outcome: "winner", validFrom: "2026-05-29T00:00:00.000Z" }),
        memory({ id: "m2", companyId: "co_2", outcome: "winner", validTo: "2026-05-29T11:59:59.000Z" }),
        memory({ id: "m3", companyId: "co_3", outcome: "winner", validFrom: "2026-05-29T12:01:00.000Z" }),
        memory({ id: "m4", companyId: "co_4", outcome: "winner", validFrom: "2026-05-29T00:00:00.000Z" }),
        memory({ id: "m5", companyId: "co_5", outcome: "winner", validFrom: "2026-05-29T00:00:00.000Z" }),
      ],
    });

    const lessons = await getCreativePerformanceLessons("headline:urgency", {
      minCompanies: 3,
      minSampleSize: 3,
    }, deps);

    expect(lessons).toEqual([expect.objectContaining({
      sampleSize: 3,
      contributingCompanies: 3,
    })]);
  });
});

function memoryDeps(overrides: { memories?: CreativePerformanceMemory[] } = {}) {
  const memories: CreativePerformanceMemory[] = overrides.memories ?? [];
  return {
    store: {
      createCreativePerformanceMemory: vi.fn(async (input) => {
        const item = memory({
          id: `mem_${memories.length + 1}`,
          ...input,
        });
        memories.push(item);
        return item;
      }),
      listCreativePerformanceMemories: vi.fn(async (featureKey) =>
        memories.filter((item) => item.featureKey === featureKey)
      ),
    },
    now: () => "2026-05-29T12:00:00.000Z",
  };
}

function memory(patch: Partial<CreativePerformanceMemory>): CreativePerformanceMemory {
  return {
    id: "mem_1",
    companyId: "co_1",
    featureKey: "headline:urgency",
    outcome: "winner",
    sampleSize: 1,
    sourceCampaignIds: ["camp_1"],
    privacyScope: "company",
    validFrom: "2026-05-29T00:00:00.000Z",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...patch,
  };
}
