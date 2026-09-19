/**
 * The run-scoped hooks, and the one bridge that carries a hook's notice back onto the run bus.
 *
 * The fleet-memory hook measures the wrapper's injection against `context.ceiling_chars` while a
 * seat call is in flight (`fleet-memory/tiers.ts`). The bus has no `context_pressure` kind — its 20
 * kinds mirror `apps/web/lib/orchestrator-events.ts`, which is read-only — so the notice rides
 * `step_note`, the kind the pipeline already uses for a remark about a step. The bridge is keyed by
 * run id because one hook serves every concurrent run of the orchestrator.
 */

import { describe, expect, it } from "vitest";
import { bridgeContextNotices, closeRunScope, createContextNoticeBus, openRunScope, type RunScopedHook } from "./run-hooks.js";
import type { OrcEvent } from "./types.js";

function recorder(): { hook: RunScopedHook; started: string[]; finished: string[] } {
  const started: string[] = [];
  const finished: string[] = [];
  return {
    started,
    finished,
    hook: {
      runStarted: (input) => void started.push(`${input.runId}:${input.objective}:${input.history?.length ?? "none"}`),
      runFinished: (runId) => void finished.push(runId),
    },
  };
}

describe("run scope", () => {
  it("opens and closes every hook, and omits an absent history rather than passing an empty one", () => {
    const a = recorder();
    const b = recorder();
    openRunScope([a.hook, undefined, b.hook], "run_1", { companyId: "co", objective: "ship it" });
    expect(a.started).toEqual(["run_1:ship it:none"]);
    expect(b.started).toEqual(["run_1:ship it:none"]);
    openRunScope([a.hook], "run_2", { companyId: "co", objective: "again", history: [{ role: "user", content: "x" }] });
    expect(a.started.at(-1)).toBe("run_2:again:1");
    closeRunScope([a.hook, undefined, b.hook], "run_1");
    expect(a.finished).toEqual(["run_1"]);
    closeRunScope([a.hook], undefined);
    expect(a.finished).toEqual(["run_1"]);
  });
});

describe("the context-notice bridge", () => {
  it("delivers one step_note on the run the notice names", () => {
    let sink: ((notice: { runId: string; detail: string }) => void) | undefined;
    const delivered: OrcEvent[] = [];
    bridgeContextNotices({ setNoticeSink: (s) => { sink = s; } }, (runId) => (runId === "run_1" ? (event) => void delivered.push(event) : undefined));
    expect(sink).toBeTypeOf("function");
    sink?.({ runId: "run_1", detail: "context pressure on run run_1, seat engineer: 96000 chars" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe("step_note");
    expect(delivered[0]?.runId).toBe("run_1");
    expect(delivered[0]?.detail).toContain("96000 chars");
    expect(Date.parse(delivered[0]?.at ?? "")).not.toBeNaN();
  });

  it("drops a notice for a run that is no longer streaming instead of throwing", () => {
    let sink: ((notice: { runId: string; detail: string }) => void) | undefined;
    bridgeContextNotices({ setNoticeSink: (s) => { sink = s; } }, () => undefined);
    expect(() => sink?.({ runId: "gone", detail: "late" })).not.toThrow();
  });

  it("is a no-op when no hook is wired", () => {
    expect(() => bridgeContextNotices(undefined, () => undefined)).not.toThrow();
  });

  it("routes through the bus while a run is open and drops the notice once it closes", () => {
    let sink: ((notice: { runId: string; detail: string }) => void) | undefined;
    const delivered: OrcEvent[] = [];
    const bus = createContextNoticeBus({ setNoticeSink: (s) => { sink = s; } });
    bus.open("run_1", (event) => void delivered.push(event));
    sink?.({ runId: "run_1", detail: "at 80 percent of 60000" });
    expect(delivered).toHaveLength(1);
    closeRunScope([bus], "run_1");
    sink?.({ runId: "run_1", detail: "after the channel closed" });
    expect(delivered).toHaveLength(1);
  });
});
