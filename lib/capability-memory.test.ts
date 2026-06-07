import { vi, describe, expect, it } from "vitest";
import {
  aggregateCapabilityOutcomePatterns,
  chooseBestCapability,
  persistCapabilityMemoryRecord,
  summarizeCapability,
} from "@/lib/capability-memory";

describe("capability memory", () => {
  it("summarizes per-company seat outcomes and picks the strongest candidate", () => {
    const summary = summarizeCapability([
      { companyId: "co_1", subjectId: "engineer", taskType: "code_review", evalScore: 0.9, costCents: 100, latencyMs: 1000, outcome: "success" },
      { companyId: "co_1", subjectId: "engineer", taskType: "code_review", evalScore: 0.7, costCents: 50, latencyMs: 2000, outcome: "success" },
      { companyId: "co_1", subjectId: "growth", taskType: "code_review", evalScore: 0.4, costCents: 50, latencyMs: 1000, outcome: "failure" },
    ]);

    expect(summary["engineer:code_review"].averageScore).toBe(0.8);
    expect(chooseBestCapability(["growth", "engineer"], summary, "code_review")).toBe("engineer");
  });

  it("persists tenant-scoped capability memory through the document store", async () => {
    const createDocument = vi.fn().mockResolvedValue({ id: "doc_1" });

    const record = await persistCapabilityMemoryRecord({
      companyId: "co_1",
      subjectId: "engineer",
      taskType: "code_review",
      evalScore: 0.9,
      costCents: 100,
      latencyMs: 1000,
      outcome: "success",
      privacyScope: "tenant",
    }, { store: { createDocument }, now: () => "2026-05-30T20:00:00.000Z" });

    expect(record.privacyScope).toBe("tenant");
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      source: "capability_memory",
      memoryTier: "semantic",
      validFrom: "2026-05-30T20:00:00.000Z",
    }));
    expect(JSON.stringify(createDocument.mock.calls[0][0])).not.toContain("co_2");
  });

  it("aggregates only cross-company eligible outcomes behind k-anonymity", () => {
    const aggregate = aggregateCapabilityOutcomePatterns([
      { companyId: "a", subjectId: "engineer", taskType: "code_review", evalScore: 0.8, costCents: 100, latencyMs: 1000, outcome: "success", privacyScope: "cross_company" },
      { companyId: "b", subjectId: "engineer", taskType: "code_review", evalScore: 0.9, costCents: 100, latencyMs: 1000, outcome: "success", privacyScope: "cross_company" },
      { companyId: "c", subjectId: "engineer", taskType: "code_review", evalScore: 0.7, costCents: 100, latencyMs: 1000, outcome: "success", privacyScope: "cross_company" },
      { companyId: "d", subjectId: "growth", taskType: "copy", evalScore: 0.9, costCents: 100, latencyMs: 1000, outcome: "success", privacyScope: "tenant" },
    ], { k: 3, epsilon: 1, noiseSeed: "capability" });

    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({ pattern: "engineer:code_review:success", companyCount: 3 });
    expect(JSON.stringify(aggregate)).not.toContain('"a"');
  });
});
