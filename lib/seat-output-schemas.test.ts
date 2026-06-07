import { describe, expect, it } from "vitest";
import { seatOutputSchemas, validateSeatOutput } from "@/lib/seat-output-schemas";

describe("seat output schemas", () => {
  it("enforces structured output for every core seat", () => {
    expect(Object.keys(seatOutputSchemas)).toHaveLength(9);
    expect(() => validateSeatOutput("analyst", { summary: "ok", artifactRefs: [], metricReadout: "mrr", dataCaveats: [] })).not.toThrow();
    expect(() => validateSeatOutput("finance", { summary: "bad", artifactRefs: [] })).toThrow();
  });
});
