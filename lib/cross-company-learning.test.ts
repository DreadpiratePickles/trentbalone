import { describe, expect, it } from "vitest";
import { aggregatePrivatePatterns } from "@/lib/cross-company-learning";

describe("cross-company learning", () => {
  it("only emits k-anonymous aggregates with bounded DP noise", () => {
    const aggregates = aggregatePrivatePatterns(
      [
        { companyId: "a", pattern: "seo:brief", score: 0.8 },
        { companyId: "b", pattern: "seo:brief", score: 0.9 },
        { companyId: "c", pattern: "seo:brief", score: 0.7 },
        { companyId: "a", pattern: "ads:creative", score: 0.2 },
      ],
      { k: 3, epsilon: 1, noiseSeed: "stable" }
    );

    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]).toMatchObject({ pattern: "seo:brief", companyCount: 3 });
    expect(aggregates[0].noisyAverage).toBeGreaterThanOrEqual(0);
    expect(aggregates[0].noisyAverage).toBeLessThanOrEqual(1);
  });
});
