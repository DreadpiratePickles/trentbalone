import { beforeEach, describe, expect, it } from "vitest";
import {
  crossCompanyLearningEnabled,
  loadCrossCompanyLearnings,
  resetCrossCompanyLearningCache,
} from "./cross-company-learning-loader";
import type { CompanyPlaybookEntry } from "./company-playbook";

function e(companyId: string, text: string, topic = "growth"): CompanyPlaybookEntry {
  return {
    id: Math.random().toString(36).slice(2),
    companyId,
    kind: "add",
    topic,
    text,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

describe("cross-company-learning-loader", () => {
  beforeEach(() => resetCrossCompanyLearningCache());

  it("is disabled by default (flag off → no read, no learnings)", async () => {
    expect(crossCompanyLearningEnabled({})).toBe(false);
    const out = await loadCrossCompanyLearnings({
      objective: "anything",
      excludeCompanyId: "co",
      env: {},
      fetchEntries: async () => [e("a", "y")],
    });
    expect(out).toEqual([]);
  });

  it("requires >=2 corroborations by default so no single-company text leaks", async () => {
    const out = await loadCrossCompanyLearnings({
      objective: "pricing conversion",
      excludeCompanyId: "co_self",
      env: { CROSS_COMPANY_LEARNING_ENABLED: "1" },
      fetchEntries: async () => [
        e("co_a", "Annual pricing lifts conversion", "pricing"),
        e("co_solo", "Our one-off note mentioning Acme Corp", "pricing"),
      ],
    });
    expect(out).toEqual([]); // neither corroborated by 2 distinct companies
  });

  it("surfaces a learning corroborated across >=2 companies (current company excluded)", async () => {
    const out = await loadCrossCompanyLearnings({
      objective: "pricing conversion experiment",
      excludeCompanyId: "co_self",
      env: { CROSS_COMPANY_LEARNING_ENABLED: "1" },
      fetchEntries: async () => [
        e("co_a", "Annual pricing lifts conversion", "pricing"),
        e("co_b", "annual pricing lifts conversion", "pricing"),
        e("co_self", "Annual pricing lifts conversion", "pricing"),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].corroborations).toBe(2);
    expect(JSON.stringify(out)).not.toContain("co_");
  });

  it("honors a deliberately lowered threshold via env", async () => {
    const out = await loadCrossCompanyLearnings({
      objective: "pricing tweak",
      excludeCompanyId: "co_self",
      env: { CROSS_COMPANY_LEARNING_ENABLED: "1", CROSS_COMPANY_LEARNING_MIN_CORROBORATIONS: "1" },
      fetchEntries: async () => [e("co_a", "Pricing tweak worked", "pricing")],
    });
    expect(out).toHaveLength(1);
  });
});
