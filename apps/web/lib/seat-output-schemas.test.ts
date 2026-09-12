import { describe, expect, it } from "vitest";
import { seatOutputSchemas, validateSeatOutput } from "@/lib/seat-output-schemas";

describe("seat output schemas", () => {
  it("enforces structured output for every core seat", () => {
    expect(Object.keys(seatOutputSchemas)).toHaveLength(9);
    const output = validateSeatOutput("analyst", { summary: "ok", artifactRefs: [], metricReadout: "mrr", dataCaveats: [] });
    expect(output).toMatchObject({ whatIDidNotDo: [] });
    expect(() => validateSeatOutput("finance", { summary: "bad", artifactRefs: [] })).toThrow();
  });

  it("preserves explicit not-attempted work in every seat output contract", () => {
    const output = validateSeatOutput("engineer", {
      summary: "Implemented validator",
      artifactRefs: ["artifact_1"],
      testPlan: "vitest",
      riskNotes: [],
      whatIDidNotDo: ["Did not deploy"],
    });

    expect(output).toMatchObject({ whatIDidNotDo: ["Did not deploy"] });
  });
});
