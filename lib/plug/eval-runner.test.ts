import { describe, expect, it } from "vitest";
import { runPlugEval } from "@/lib/plug/eval-runner";
import { findPlugBySlug } from "@/lib/plug/registry";

describe("Plug eval runner", () => {
  it("runs Plug evals through the v3 trial harness", async () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");

    const result = await runPlugEval(plug);

    expect(result).toMatchObject({
      subjectType: "plug",
      subjectId: plug.id,
      version: plug.version,
      capabilityScore: 100,
    });
    expect(result.trials).toHaveLength(plug.evalSet.fixtureRefs.length);
    expect(result.trials[0]?.transcriptPath).toContain("memory://plug-evals/");
    expect(result.failureClusters).toEqual({});
  });
});
