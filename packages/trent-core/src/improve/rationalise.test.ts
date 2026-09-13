/**
 * Task I.14 — rationalisation on goldens (CS329A L6 @18:48, STaR: give the solved problem and
 * ask for the rationale). One metered call per golden; a golden whose steps already carry a
 * rationale is not asked again (content-addressed on the step list).
 */
import { describe, expect, it } from "vitest";

import { distillCleanTrace, type CleanGolden } from "./clean-trace.js";
import { SweepMeter } from "./meter.js";
import { createMemoryExemplarStore, rationaliseGolden, type RationaleFn } from "./rationalise.js";

function golden(): CleanGolden {
  return distillCleanTrace(
    {
      id: "trace_raw_2",
      runId: "run_2",
      agentId: "engineer",
      taskType: "ship-feature",
      objective: "Find a",
      blocked: false,
      steps: [
        { title: "list the directory", tool: "list_dir", args: { path: "." }, ok: true, output: "a.ts" },
        { title: "answer", ok: true, output: "a is 1" },
      ],
    },
    { candidateId: "skill_2", now: "2026-09-13T10:00:00.000Z" },
  )!;
}

describe("rationaliseGolden (I.14)", () => {
  it("asks the model once, metered under phase rationalise, and stores step + why next to the golden", async () => {
    const meter = new SweepMeter(undefined);
    const prompts: string[] = [];
    const ask: RationaleFn = async (prompt) => {
      prompts.push(prompt);
      return { text: '{"steps":[{"index":1,"why":"see what exists first"},{"index":2,"why":"the listing already answers it"}]}', costCents: 2 };
    };
    const store = createMemoryExemplarStore();
    const out = await rationaliseGolden(golden(), { ask, meter, store });
    expect(out.rationalised).toBe(true);
    expect(out.golden.rationale).toEqual(["see what exists first", "the listing already answers it"]);
    expect(typeof out.golden.rationaleOf).toBe("string");
    expect(meter.phases.rationalise).toEqual({ calls: 1, costCents: 2 });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("list the directory");
    expect((await store.get(out.golden.id))?.rationale).toEqual(out.golden.rationale);
  });

  it("a golden that already has a rationale for these steps is not re-rationalised", async () => {
    const meter = new SweepMeter(undefined);
    let calls = 0;
    const ask: RationaleFn = async () => {
      calls += 1;
      return { text: '{"steps":[{"index":1,"why":"a"},{"index":2,"why":"b"}]}', costCents: 1 };
    };
    const store = createMemoryExemplarStore();
    const first = await rationaliseGolden(golden(), { ask, meter, store });
    const second = await rationaliseGolden(first.golden, { ask, meter, store });
    expect(second.rationalised).toBe(false);
    expect(calls).toBe(1);
    expect(meter.phases.rationalise.calls).toBe(1);
    // A changed step list is a different content address, so it IS asked again.
    const changed: CleanGolden = { ...first.golden, steps: [...first.golden.steps, { title: "extra" }] };
    const third = await rationaliseGolden(changed, { ask, meter, store });
    expect(third.rationalised).toBe(true);
    expect(calls).toBe(2);
  });

  it("a reply that is not the expected JSON stores no rationale and still counts the call", async () => {
    const meter = new SweepMeter(undefined);
    const out = await rationaliseGolden(golden(), { ask: async () => ({ text: "not json", costCents: 1 }), meter, store: createMemoryExemplarStore() });
    expect(out.rationalised).toBe(false);
    expect(out.golden.rationale).toBeUndefined();
    expect(meter.phases.rationalise.calls).toBe(1);
  });
});
