/**
 * [S2] The protocol servers (`trent a2a serve`, `trent acp`) on the runner port. The runner they are
 * handed runs each task on the runtime's runner by mode: an A2A context is its conversation (council
 * A2) under the `questions` hold policy (a question parks and the peer's next message answers it; a
 * side effect is refused, a peer never approves one), ACP under `deny`. On solo the runner also carries
 * `answer` and `resume`, which is how `A2ATaskEngine` continues a task parked on a question. `--solo`
 * reaches the runtime. The runtime is a recording fake.
 */
import { describe, expect, it } from "vitest";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { HeadlessRunOptions, HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";
import type { ModeRunner } from "../../runtime/runner-for-mode.js";
import { createContext } from "../context.js";
import { openProtocolRuntime } from "../groups/protocol-runtime.js";

function fakeRuntime(mode: "fleet" | "solo", built: HeadlessRuntimeDeps[], runs: Array<{ objective: string; options: HeadlessRunOptions }>) {
  const runner = {
    mode,
    label: mode,
    run: () => (async function* (): AsyncGenerator<OrcEvent> {})(),
    approve: async () => true,
    reject: async () => true,
    answer: async () => true,
    ...(mode === "solo" ? { resume: () => (async function* (): AsyncGenerator<OrcEvent> {})() } : {}),
  } as ModeRunner;
  return async (deps: HeadlessRuntimeDeps): Promise<HeadlessRuntime> => {
    built.push(deps);
    return {
      mode,
      runner,
      run: (objective: string, options: HeadlessRunOptions = {}) => {
        runs.push({ objective, options });
        return (async function* (): AsyncGenerator<OrcEvent> {})();
      },
      cleanup: async () => undefined,
    } as unknown as HeadlessRuntime;
  };
}

const ctxWith = (gatewayRuntime: (deps: HeadlessRuntimeDeps) => Promise<HeadlessRuntime>) => createContext({}, { out: () => undefined, err: () => undefined, overrides: { gatewayRuntime } });

describe("[S2] openProtocolRuntime on the runner port", () => {
  it("A2A: the context is the conversation, holds are `questions`, and a solo runner carries answer and resume", async () => {
    const built: HeadlessRuntimeDeps[] = [];
    const runs: Array<{ objective: string; options: HeadlessRunOptions }> = [];
    const { runner, release } = await openProtocolRuntime(ctxWith(fakeRuntime("solo", built, runs)), "a2a", "solo");
    for await (const _ of runner.run({ objective: "pick a stain", conversation: "ctx-7" } as never)) void _;
    expect(built[0]).toMatchObject({ surface: "a2a", mode: "solo" });
    expect(runs).toEqual([{ objective: "pick a stain", options: { conversation: "ctx-7", holds: "questions" } }]);
    expect(typeof (runner as { resume?: unknown }).resume).toBe("function");
    expect(typeof (runner as { answer?: unknown }).answer).toBe("function");
    await release();
  });

  it("ACP: every hold is refused; the fleet runner carries no resume, so a task is never continued by text", async () => {
    const built: HeadlessRuntimeDeps[] = [];
    const runs: Array<{ objective: string; options: HeadlessRunOptions }> = [];
    const { runner } = await openProtocolRuntime(ctxWith(fakeRuntime("fleet", built, runs)), "acp");
    for await (const _ of runner.run({ objective: "explain the diff" })) void _;
    expect(built[0]?.mode).toBeUndefined();
    expect(runs).toEqual([{ objective: "explain the diff", options: { holds: "deny" } }]);
    expect((runner as { resume?: unknown }).resume).toBeUndefined();
  });
});
