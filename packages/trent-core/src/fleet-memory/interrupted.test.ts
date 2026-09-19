/**
 * [G2] An interrupted fragment is never handed to the next run as if it were an answer.
 *
 * The conversation already refuses to thread a stopped turn (`apps/cli/src/repl/conversation.ts`).
 * These are the other three doors a stopped turn's text can walk through: cross-agent recall, the
 * app's episodic tier (and the consolidation that promotes from it), and the brain's daily notes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { record } from "../tools/action.js";
import type { MemoryAdapter } from "../tools/memory/index.js";
import {
  forgetInterruptedAppends,
  withAppEpisodicMirror,
  writeConsolidatedFacts,
  type AppMemoryWriteModules,
} from "./app-writes.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { recallForObjective } from "./recall.js";
import { guardInterrupted, isSettledRun, InMemoryFleetSource, type FleetMemoryEntry, type FleetRun, type FleetStep } from "./source.js";

const COMPANY = "co_interrupted";
const TOKEN = "pelican-harbour-4417";
const OBJECTIVE = "draft the migration plan for the pelican harbour rollout";

function step(overrides: Partial<FleetStep> & { id: string; output: string }): FleetStep {
  return { runId: "run_1", agentRole: "engineer", title: "draft the migration plan", status: "completed", ...overrides };
}

function run(steps: readonly FleetStep[], overrides: Partial<FleetRun> = {}): FleetRun {
  return {
    id: "run_1",
    companyId: COMPANY,
    objective: OBJECTIVE,
    status: "completed",
    summary: null,
    completedAt: "2026-09-18T10:00:00.000Z",
    steps,
    ...overrides,
  };
}

const partial = `the migration plan for the pelican harbour rollout starts with ${TOKEN}`;

describe("recall and the runs nobody finished", () => {
  it("recalls a completed run's step output", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(run([step({ id: "s1", output: partial })]));
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "analyst", objective: OBJECTIVE });
    expect(result.block).toContain(TOKEN);
  });

  it("recalls nothing from a run that is still shown in flight: a stopped turn is not an answer", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(run([step({ id: "s1", output: partial })], { status: "running", completedAt: null }));
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "analyst", objective: OBJECTIVE });
    expect(result.block).not.toContain(TOKEN);
    expect(result.items).toEqual([]);
  });

  it("excludes a step this process watched being interrupted, whatever the store's step row says", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(run([step({ id: "s1", output: partial, interrupted: true }), step({ id: "s2", output: "the rollout window is the first week of October" })]));
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "analyst", objective: OBJECTIVE });
    expect(result.block).not.toContain(TOKEN);
    expect(result.items.map((item) => item.label).join(" ")).toContain("engineer");
  });

  it("isSettledRun reads the run row, not the step rows", () => {
    expect(isSettledRun({ status: "completed" })).toBe(true);
    expect(isSettledRun({ status: "failed" })).toBe(true);
    expect(isSettledRun({ status: "running" })).toBe(false);
    expect(isSettledRun({ status: "awaiting_approval" })).toBe(false);
  });
});

describe("guardInterrupted", () => {
  const entries: FleetMemoryEntry[] = [
    { source: "tiers", id: "d1", label: "episodic | run_1", text: partial, runId: "run_1" },
    { source: "tiers", id: "d2", label: "episodic | run_2", text: "the rollout window is the first week of October", runId: "run_2" },
  ];

  function sourceWithAppMemory(): InMemoryFleetSource & { listAppMemory(companyId: string, seat: string): Promise<readonly FleetMemoryEntry[]> } {
    const base = new InMemoryFleetSource();
    base.addRun(run([step({ id: "s1", output: partial })]));
    return Object.assign(base, { listAppMemory: async () => entries });
  }

  it("tags the steps of a run the wrapper stopped and drops that run's app-memory rows", async () => {
    const guarded = guardInterrupted(sourceWithAppMemory(), { run: (runId) => runId === "run_1", step: () => false });
    const runs = await guarded.listRuns(COMPANY);
    expect(runs[0]?.steps[0]?.interrupted).toBe(true);
    const app = await guarded.listAppMemory!(COMPANY, "analyst");
    expect(app.map((entry) => entry.id)).toEqual(["d2"]);
  });

  it("drops the interrupted steps outright for a reader that has no notion of the tag", async () => {
    const guarded = guardInterrupted(sourceWithAppMemory(), { run: () => false, step: (_runId, stepId) => stepId === "s1" }, { drop: true });
    const runs = await guarded.listRuns(COMPANY);
    expect(runs[0]?.steps).toEqual([]);
  });
});

describe("the app-memory mirror and a step that did not complete", () => {
  afterEach(() => forgetInterruptedAppends());

  function fakeModules(): AppMemoryWriteModules & { episodes: string[]; facts: string[] } {
    const episodes: string[] = [];
    const facts: string[] = [];
    return {
      episodes,
      facts,
      async writeEpisodicMemory(options) {
        episodes.push(options.summary);
      },
      createSemanticMemory() {
        const staged: string[] = [];
        return {
          add: (fact) => void staged.push(fact.content),
          flush: async () => {
            facts.push(...staged);
            return staged.map((_, i) => ({ id: `doc_${i}` }));
          },
        };
      },
      async listDocuments() {
        return [];
      },
      async expireDocument() {},
    };
  }

  const adapter = (): MemoryAdapter =>
    ({
      name: "memory",
      scopes: [],
      schemas: [],
      estimateCost: () => 0,
      requiresApproval: () => false,
      cleanup: async () => {},
      frozenSnapshot: () => "",
      thaw: () => {},
      bindCallerContext: () => {},
      execute: async (action: string) => record("memory", action, "completed", "done"),
      dryRun: async (action: string) => record("memory", action, "mocked", "dry run"),
    }) as unknown as MemoryAdapter;

  const append = `memory {"action":"add","content":${JSON.stringify(partial)}}`;

  it("holds a step's append until the step completes, then writes exactly one row", async () => {
    const modules = fakeModules();
    const mirror = withAppEpisodicMirror(adapter(), {
      modules,
      caller: () => ({ companyId: COMPANY, runId: "run_1", seat: "engineer", stepId: "s1" }),
    });
    await mirror.adapter.execute(append, {});
    expect(modules.episodes).toEqual([]);
    await mirror.stepSettled({ runId: "run_1", stepId: "s1", completed: true });
    expect(modules.episodes).toEqual([partial]);
  });

  it("writes no episodic row for a step whose seat call never finished", async () => {
    const modules = fakeModules();
    const mirror = withAppEpisodicMirror(adapter(), {
      modules,
      caller: () => ({ companyId: COMPANY, runId: "run_1", seat: "engineer", stepId: "s1" }),
    });
    await mirror.adapter.execute(append, {});
    mirror.runEnded("run_1");
    expect(modules.episodes).toEqual([]);
  });

  it("refuses to promote a consolidated fact carrying an interrupted step's append", async () => {
    const modules = fakeModules();
    const mirror = withAppEpisodicMirror(adapter(), {
      modules,
      caller: () => ({ companyId: COMPANY, runId: "run_1", seat: "engineer", stepId: "s1" }),
    });
    await mirror.adapter.execute(append, {});
    await mirror.stepSettled({ runId: "run_1", stepId: "s1", completed: false });

    const outcome = await writeConsolidatedFacts({
      companyId: COMPANY,
      block: "memory",
      entries: [],
      ops: [
        { op: "append", text: partial },
        { op: "append", text: "the rollout window is the first week of October" },
      ],
      modules,
    });
    expect(modules.facts).toEqual(["the rollout window is the first week of October"]);
    expect(outcome.written).toBe(1);
    expect(outcome.skipped).toBe(1);
  });
});

describe("a run that closes around a step still running", () => {
  it("marks the step and the run interrupted, and tells the mirror the step did not complete", async () => {
    const settled: Array<{ stepId: string; completed: boolean; seat: string }> = [];
    const hook = createFleetMemoryHook({
      source: new InMemoryFleetSource(),
      memory: { blocks: [], frozenSnapshot: () => "", thaw: () => {}, bindCallerContext: () => {} } as never,
      brain: false,
      onStepSettled: (step) => settled.push({ stepId: step.stepId, completed: step.completed, seat: step.seat }),
    });
    hook.runStarted({ runId: "run_1", companyId: COMPANY, objective: OBJECTIVE });
    let release = () => {};
    const call = hook.wrapSeatModel(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "late";
    })({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: OBJECTIVE } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    hook.runFinished("run_1");
    expect(settled).toEqual([{ stepId: "s1", completed: false, seat: "engineer" }]);
    expect(hook.stepInterrupted("run_1", "s1")).toBe(true);
    release();
    await call;
    expect(hook.stepInterrupted("run_1", "s1")).toBe(true);
  });
});

describe("the brain's daily note and a step still in flight", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function notesOf(profileDir: string): string {
    const dir = path.join(profileDir, "brain", "memory");
    if (!fs.existsSync(dir)) return "";
    return fs.readdirSync(dir).map((file) => fs.readFileSync(path.join(dir, file), "utf8")).join("\n");
  }

  it("refuses a note for a step whose seat call has not returned, and accepts it once it has", async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-interrupted-"));
    dirs.push(profileDir);
    const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir });
    hook.runStarted({ runId: "run_1", companyId: COMPANY, objective: OBJECTIVE });
    const failure = { objective: OBJECTIVE, seat: "engineer", reason: partial, runId: "run_1", stepId: "s1" };
    let duringStep: boolean | undefined;
    const wrapped = hook.wrapSeatModel(async () => {
      duringStep = hook.stepFailed(failure);
      return "done";
    });
    await wrapped({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: OBJECTIVE } });
    expect(duringStep).toBe(false);
    expect(notesOf(profileDir)).not.toContain(TOKEN);
    // Once the step has ended, the failure channel does its job: the line is written, and it is
    // written as a failure. That is the whole distinction — what was tried and lost is marked as
    // such, while what a stopped step produced is never offered as an answer at all.
    expect(hook.stepFailed(failure)).toBe(true);
    expect(notesOf(profileDir)).toContain(TOKEN);
    expect(notesOf(profileDir)).toContain("[failure]");
  });
});
