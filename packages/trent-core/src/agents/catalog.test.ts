import { describe, it, expect } from "vitest";
import { AGENT_CATALOG, CATEGORY_LABELS, agentsByCategory, getCatalogAgent } from "./index.js";

/** Per-category head-count of the 164-specialist fleet (Stage 00 audit). */
const EXPECTED_CATEGORY_COUNTS: Record<string, number> = {
  engineering: 29,
  design: 8,
  "paid-media": 7,
  sales: 8,
  marketing: 30,
  product: 5,
  "project-management": 6,
  testing: 8,
  support: 6,
  finance: 5,
  "spatial-computing": 6,
  academic: 5,
  specialized: 41,
};

describe("agents wrapper — the 164-specialist catalog", () => {
  it("contains exactly 164 agents with unique ids", () => {
    expect(AGENT_CATALOG).toHaveLength(164);
    expect(new Set(AGENT_CATALOG.map((a) => a.id)).size).toBe(164);
  });

  it("matches the audited head-count for all 13 categories", () => {
    const counts: Record<string, number> = {};
    for (const agent of AGENT_CATALOG) counts[agent.category] = (counts[agent.category] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_CATEGORY_COUNTS);
    expect(Object.keys(EXPECTED_CATEGORY_COUNTS)).toHaveLength(13);
    const summed = Object.values(EXPECTED_CATEGORY_COUNTS).reduce((a, b) => a + b, 0);
    expect(summed).toBe(164);
  });

  it("labels every category present in the catalog", () => {
    for (const category of Object.keys(EXPECTED_CATEGORY_COUNTS)) {
      expect(CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS]).toBeTruthy();
    }
  });

  it("groups agents by category consistently with the flat catalog", () => {
    const grouped = agentsByCategory();
    for (const [category, expected] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
      expect(grouped[category as keyof typeof grouped]?.length ?? 0).toBe(expected);
    }
  });

  it("looks an agent up by profile id and returns undefined for an unknown one", () => {
    expect(getCatalogAgent("eng-frontend-developer")?.category).toBe("engineering");
    expect(getCatalogAgent("not-an-agent")).toBeUndefined();
  });
});
