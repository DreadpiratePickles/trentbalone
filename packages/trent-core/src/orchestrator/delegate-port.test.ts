/**
 * The orchestrator-side `DelegatePort`: a `delegate_task` call from a seat becomes one `[delegated]`
 * child step in the SAME run, executed to completion, and the parent receives the child's output and
 * tool-call statuses untouched. Proven here against a fake child runner (the fake orchestrator); the
 * real runner is exercised end to end from the REPL test.
 */
import { describe, expect, it } from "vitest";
import {
  createOrchestratorDelegatePort,
  DELEGATE_MAX_CHILDREN,
  DELEGATE_MAX_DEPTH,
  type DelegatedChildRunner,
  type DelegatedChildSpec,
} from "./delegate-port.js";
import type { SeatModelFn, SeatModelInput } from "./seat-guard.js";

const RUN = { runId: "run_1", companyId: "co_1", objective: "ship the notes app" };

function fakeRunner(overrides: Partial<DelegatedChildRunner> = {}) {
  const specs: DelegatedChildSpec[] = [];
  let count = 0;
  const runner: DelegatedChildRunner = {
    delegatedCount: async () => count,
    run: async (spec) => {
      specs.push(spec);
      count += 1;
      return {
        agent: spec.agent ?? "support",
        status: "completed",
        output: `child ${count} did: ${spec.task}`,
        toolCalls: [{ adapter: "memory", action: "memory add", status: "blocked", summary: "This seat is delegated and has read-only memory." }],
      };
    },
    ...overrides,
  };
  return { runner, specs };
}

const seatResult = { output: {}, model: "m", tokens: 1, costCents: 0, fallback: false };
const seatCall = (id: string, seat: string): SeatModelInput => ({ subtask: { id, seat } });

/** Drives one seat call through the wrapper so the port knows which step is delegating. */
async function seatCalled(port: ReturnType<typeof createOrchestratorDelegatePort>, id: string, seat: string): Promise<void> {
  const wrapped: SeatModelFn = port.wrapSeatModel(async () => seatResult);
  await wrapped(seatCall(id, seat));
}

describe("createOrchestratorDelegatePort", () => {
  it("turns a delegate_task request into a child step of the calling run and returns the child's result as-is", async () => {
    const { runner, specs } = fakeRunner();
    const port = createOrchestratorDelegatePort({ runner });
    port.runStarted(RUN);
    await seatCalled(port, "step_parent", "engineer");

    const result = await port.delegate({ task: "write the release notes", context: "v2 shipped", agent: "content" });

    expect(specs).toHaveLength(1);
    expect(specs[0]?.stepId).toMatch(/^step_/);
    expect(specs[0]).toMatchObject({ runId: "run_1", companyId: "co_1", parentStepId: "step_parent", parentSeat: "engineer", task: "write the release notes", context: "v2 shipped", agent: "content", depth: 1 });
    expect(result.status).toBe("completed");
    expect(result.output).toBe("child 1 did: write the release notes");
    expect(result.agent).toBe("content");
    expect(result.runId).toBe("run_1");
    expect(result.toolCalls?.[0]).toMatchObject({ adapter: "memory", status: "blocked" });
  });

  it("refuses without a run or without a seat call, never inventing a child", async () => {
    const { runner, specs } = fakeRunner();
    const port = createOrchestratorDelegatePort({ runner });
    const noRun = await port.delegate({ task: "anything" });
    expect(noRun.status).toBe("failed");
    expect(noRun.output).toMatch(/no orchestration run/i);
    port.runStarted(RUN);
    const noSeat = await port.delegate({ task: "anything" });
    expect(noSeat.status).toBe("failed");
    expect(noSeat.output).toMatch(/no seat/i);
    expect(specs).toHaveLength(0);
  });

  it(`keeps the pipeline's cap of ${DELEGATE_MAX_CHILDREN} delegated steps per run`, async () => {
    const { runner, specs } = fakeRunner();
    const port = createOrchestratorDelegatePort({ runner });
    port.runStarted(RUN);
    await seatCalled(port, "step_parent", "engineer");
    for (let i = 0; i < DELEGATE_MAX_CHILDREN; i += 1) {
      expect((await port.delegate({ task: `task ${i}` })).status).toBe("completed");
    }
    const seventh = await port.delegate({ task: "one too many" });
    expect(seventh.status).toBe("blocked");
    expect(seventh.output).toMatch(new RegExp(`budget.*${DELEGATE_MAX_CHILDREN}`));
    expect(specs).toHaveLength(DELEGATE_MAX_CHILDREN);
  });

  it("counts children still in flight against the cap, so one call with many tasks cannot beat it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runner, specs } = fakeRunner({ delegatedCount: async () => 0 });
    const slow: DelegatedChildRunner = { ...runner, run: async (spec) => { await gate; return runner.run(spec); } };
    const port = createOrchestratorDelegatePort({ runner: slow });
    port.runStarted(RUN);
    await seatCalled(port, "step_parent", "engineer");
    const results = Promise.all(Array.from({ length: DELEGATE_MAX_CHILDREN + 2 }, (_, i) => port.delegate({ task: `t${i}` })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const settled = await results;
    expect(settled.filter((r) => r.status === "blocked")).toHaveLength(2);
    expect(specs).toHaveLength(DELEGATE_MAX_CHILDREN);
  });

  it(`stops nesting past depth ${DELEGATE_MAX_DEPTH}: a child may delegate, a grandchild may not`, async () => {
    const { runner, specs } = fakeRunner();
    const port = createOrchestratorDelegatePort({ runner });
    port.runStarted(RUN);
    await seatCalled(port, "step_parent", "engineer");
    const child = await port.delegate({ task: "level one" });
    expect(child.status).toBe("completed");
    // The child's seat now runs (under the id the port assigned) and delegates again.
    await seatCalled(port, specs[0]!.stepId, "support");
    const grandchild = await port.delegate({ task: "level two" });
    expect(grandchild.status).toBe("completed");
    await seatCalled(port, specs[1]!.stepId, "analyst");
    const great = await port.delegate({ task: "level three" });
    expect(great.status).toBe("blocked");
    expect(great.output).toMatch(/depth/);
  });

  it("reports a runner failure as failed with the message, and clears the run on runFinished", async () => {
    const { runner } = fakeRunner({ run: async () => { throw new Error("pipeline refused"); } });
    const port = createOrchestratorDelegatePort({ runner });
    port.runStarted(RUN);
    await seatCalled(port, "step_parent", "engineer");
    const failed = await port.delegate({ task: "x" });
    expect(failed.status).toBe("failed");
    expect(failed.output).toContain("pipeline refused");
    port.runFinished("run_1");
    const after = await port.delegate({ task: "x" });
    expect(after.status).toBe("failed");
    expect(after.output).toMatch(/no orchestration run/i);
  });
});
