/**
 * The run-scoped hooks, and the one bridge that carries a hook's notice back onto the run bus.
 *
 * The fleet-memory hook measures the wrapper's injection against `context.ceiling_chars` while a
 * seat call is in flight (`fleet-memory/tiers.ts`). The bus has no `context_pressure` kind — its 20
 * kinds mirror `apps/web/lib/orchestrator-events.ts`, which is read-only — so the notice rides
 * `step_note`, the kind the pipeline already uses for a remark about a step. The bridge is keyed by
 * run id because one hook serves every concurrent run of the orchestrator.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import { bridgeContextNotices, closeRunScope, createContextNoticeBus, openRunScope, recordRunSpend, type RunScopedHook } from "./run-hooks.js";
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

/**
 * [G3] Every run's cost reaches the one daily ledger through the run-end hook, tagged with the
 * surface that asked for the run. Nothing here calls a model: the usage figures are the integer
 * cents the gateway's usage events already carry.
 */
describe("the run spend recorder", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-run-spend-"));
    installSpendLedger(openSpendLedger({ profileDir, now: () => new Date("2026-09-18T12:00:00.000Z") }));
  });

  afterEach(() => {
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("writes the run's cost at run end, tagged with the surface and grouped by model", () => {
    const a = recorder();
    openRunScope([a.hook], "run_1", { companyId: "co", objective: "ship it", surface: "gateway" });
    recordRunSpend("run_1", { model: "claude-sonnet-4", provider: "anthropic", cents: 12, tokens: 800, seat: "engineer" });
    recordRunSpend("run_1", { model: "claude-sonnet-4", provider: "anthropic", cents: 3, tokens: 200, seat: "engineer" });
    recordRunSpend("run_1", { model: "claude-opus-4", provider: "anthropic", cents: 40, tokens: 1000 });
    // Nothing is written while the run is in flight; the run-end hook is the only writer.
    expect(currentSpendLedger()?.rows()).toEqual([]);

    closeRunScope([a.hook], "run_1");
    const rows = currentSpendLedger()?.rows() ?? [];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.surface === "gateway" && row.run_id === "run_1")).toBe(true);
    expect(rows.find((row) => row.model === "claude-sonnet-4")).toMatchObject({ cents: 15, tokens: 1000, seat: "engineer", provider: "anthropic" });
    expect(rows.find((row) => row.model === "claude-opus-4")).toMatchObject({ cents: 40, tokens: 1000 });
    expect(currentSpendLedger()?.runTotalCents("run_1")).toBe(55);
    // The hooks are still closed, and the run's scope is gone: a second close writes nothing more.
    expect(a.finished).toEqual(["run_1"]);
    closeRunScope([a.hook], "run_1");
    expect(currentSpendLedger()?.rows()).toHaveLength(2);
  });

  it("tags a run whose options name no surface as unknown rather than guessing one", () => {
    openRunScope([], "run_2", { companyId: "co", objective: "no surface" });
    recordRunSpend("run_2", { model: "gpt-4.1", provider: "openai", cents: 5, tokens: 100 });
    closeRunScope([], "run_2");
    expect(currentSpendLedger()?.rows()[0]).toMatchObject({ surface: "unknown", run_id: "run_2", provider: "openai" });
  });

  it("writes nothing for a run that cost nothing, and drops usage for a run nobody opened", () => {
    openRunScope([], "run_3", { companyId: "co", objective: "free" });
    closeRunScope([], "run_3");
    expect(() => recordRunSpend("run_never", { model: "m", provider: "p", cents: 9, tokens: 1 })).not.toThrow();
    expect(currentSpendLedger()?.rows()).toEqual([]);
  });

  it("is inert when no ledger is installed, so a process that opted out behaves exactly as before", () => {
    installSpendLedger(undefined);
    const a = recorder();
    openRunScope([a.hook], "run_4", { companyId: "co", objective: "no ledger", surface: "repl" });
    recordRunSpend("run_4", { model: "m", provider: "p", cents: 7, tokens: 10 });
    expect(() => closeRunScope([a.hook], "run_4")).not.toThrow();
    expect(a.finished).toEqual(["run_4"]);
    expect(fs.existsSync(path.join(profileDir, "spend.ndjson"))).toBe(false);
  });
});
