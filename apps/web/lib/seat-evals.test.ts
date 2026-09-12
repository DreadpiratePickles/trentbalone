import { describe, expect, it } from "vitest";
import { buildAllSeatEvalFixtures, buildSeatEvalFixtures } from "@/lib/seat-evals";

describe("seat eval fixtures", () => {
  it("seeds at least 20 eval fixtures per core seat with capability and regression coverage", () => {
    const seats = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"] as const;
    const fixtures = buildAllSeatEvalFixtures([...seats]);

    expect(fixtures).toHaveLength(180);
    for (const seat of seats) {
      const seatFixtures = buildSeatEvalFixtures(seat);
      expect(seatFixtures).toHaveLength(20);
      expect(seatFixtures.filter((fixture) => fixture.kind === "capability")).toHaveLength(10);
      expect(seatFixtures.filter((fixture) => fixture.kind === "regression")).toHaveLength(10);
    }
  });
});
