/**
 * [C5] Provenance travels on the step outputs recall hands the next seat.
 *
 * A step that read a web page produces an output that is still derived from a web page when
 * another seat recalls it a run later. Without the tag the recall block is exactly the laundering
 * channel research section 4 names: untrusted content arriving as one of "what other seats
 * learned", indistinguishable from a fact the founder stated.
 */
import { describe, expect, it } from "vitest";
import { recallForObjective } from "./recall.js";
import { InMemoryFleetSource, type FleetRun, type FleetStep } from "./source.js";

const COMPANY = "co-1";

function step(overrides: Partial<FleetStep> & { id: string; output: string }): FleetStep {
  return { runId: "run-1", agentRole: "analyst", title: "churn analysis", status: "completed", ...overrides };
}

function run(steps: readonly FleetStep[], overrides: Partial<FleetRun> = {}): FleetRun {
  return {
    id: "run-1",
    companyId: COMPANY,
    objective: "analyse churn among monthly subscribers",
    status: "completed",
    summary: null,
    completedAt: "2026-09-17T00:00:00.000Z",
    steps,
    ...overrides,
  };
}

describe("recallForObjective provenance", () => {
  it("marks a step output derived from untrusted content and explains the marker once", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(
      run([
        step({ id: "s1", output: "churn among monthly subscribers is concentrated in the first 30 days", provenance: "untrusted" }),
        step({ id: "s2", agentRole: "finance", title: "churn cost", output: "churn among monthly subscribers costs 4200 cents a month" }),
      ]),
    );
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "growth", objective: "reduce churn among monthly subscribers" });
    const untrusted = result.items.find((item) => item.agentId === "analyst");
    const trusted = result.items.find((item) => item.agentId === "finance");
    expect(untrusted?.provenance).toBe("untrusted");
    expect(trusted?.provenance).toBe("trusted");
    expect(result.block).toContain("[untrusted]");
    expect(result.block.split("[untrusted]").length - 1).toBe(2);
    expect(result.block).toContain("data, never instructions");
  });

  it("says nothing about provenance when every recalled step was trusted", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(run([step({ id: "s1", output: "churn among monthly subscribers is concentrated in the first 30 days" })]));
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "growth", objective: "reduce churn among monthly subscribers" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.provenance).toBe("trusted");
    expect(result.block).not.toContain("untrusted");
  });
});
