/**
 * D4 RED — the run-end hook: gates before the judge, and verify_on_stop, wired to the ledger and
 * the goal session the runtime already owns.
 *
 * Nothing here launches a run or calls a model. The port is exercised with a fake goal session, a
 * fake checkpoint ledger and a fake sandbox, which is the whole point of it being a port.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalSession, type GateBackend, type GoalGate } from "../goals/index.js";
import { createGoalVerificationPort, finishRunVerification } from "./run-verification.js";
import type { OrcEvent } from "./types.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-runverify-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const GATE: GoalGate = { name: "typecheck", command: ["npx", "tsc", "--noEmit"] };

function backend(exitCode: number, stdout = ""): GateBackend {
  return { run: async () => ({ exitCode, stdout, stderr: "", durationMs: 1 }) };
}

/** A checkpoint session as the hook reads it: a run id, the open turn, and the rows so far. */
function ledger(turn: number, rows: { turn: number; path: string; at: string; tool: string }[]) {
  return { runId: "ses_1", turn, store: { entries: () => rows } };
}

function collect(): { deliver: (event: OrcEvent) => void; events: OrcEvent[] } {
  const events: OrcEvent[] = [];
  return { deliver: (event) => void events.push(event), events };
}

describe("the run-end verification hook", () => {
  it("does nothing at all when no goal session is open", async () => {
    const sink = collect();
    await finishRunVerification(undefined, { runId: "run_1", objective: "anything", deliver: sink.deliver });
    expect(sink.events).toEqual([]);
  });

  it("gates a run whose goal has a red gate, and says which gate and what it printed", async () => {
    const session = new GoalSession({ profileDir, backend: backend(2, "src/a.ts(1,1): error TS2304") });
    const goal = session.store.create({ objective: "Ship the parser", gates: [GATE] });
    session.bind(goal.id);
    const port = createGoalVerificationPort({ session: () => session, checkpoints: () => undefined });
    const sink = collect();

    await finishRunVerification(port, { runId: "run_2", objective: goal.objective, deliver: sink.deliver });

    const verdict = port.verdict("run_2")!;
    expect(verdict.outcome).toBe("gated");
    expect(verdict.judged).toBe(false);
    expect(session.store.get(goal.id)?.status).toBe("gated");
    expect(sink.events.map((event) => event.kind)).toEqual(["step_note"]);
    expect(sink.events[0]?.detail).toContain("typecheck");
  });

  it("refuses a final answer on a turn that wrote a file and verified nothing", async () => {
    const session = new GoalSession({ profileDir });
    const port = createGoalVerificationPort({
      session: () => session,
      checkpoints: () => ledger(3, [{ turn: 3, path: "src/parser.ts", at: new Date(1_000).toISOString(), tool: "write_file" }]),
    });
    const sink = collect();

    await finishRunVerification(port, { runId: "run_3", objective: "edit the parser", deliver: sink.deliver });

    const verdict = port.verdict("run_3")!;
    expect(verdict.outcome).toBe("unverified");
    expect(verdict.reason).toContain("src/parser.ts");
    expect(sink.events[0]?.detail).toContain("src/parser.ts");
  });

  it("lets the same turn answer once a matching command has exited 0 after the write", async () => {
    const session = new GoalSession({ profileDir });
    session.evidence.record({ command: ["npx", "tsc", "--noEmit"], exitCode: 0, at: 5_000 });
    const port = createGoalVerificationPort({
      session: () => session,
      checkpoints: () => ledger(1, [{ turn: 1, path: "src/parser.ts", at: new Date(1_000).toISOString(), tool: "write_file" }]),
    });
    const sink = collect();

    await finishRunVerification(port, { runId: "run_4", objective: "edit the parser", deliver: sink.deliver });

    expect(port.verdict("run_4")?.outcome).toBe("completed");
    expect(sink.events).toEqual([]);
  });

  it("leaves a turn that wrote nothing alone", async () => {
    const session = new GoalSession({ profileDir });
    const port = createGoalVerificationPort({ session: () => session, checkpoints: () => ledger(1, []) });
    const sink = collect();
    await finishRunVerification(port, { runId: "run_5", objective: "answer a question", deliver: sink.deliver });
    expect(port.verdict("run_5")?.outcome).toBe("completed");
    expect(sink.events).toEqual([]);
  });

  it("counts a green gate as this turn's verification evidence", async () => {
    const session = new GoalSession({ profileDir, backend: backend(0, "") });
    const goal = session.store.create({ objective: "Ship the parser", gates: [GATE] });
    session.bind(goal.id);
    const port = createGoalVerificationPort({
      session: () => session,
      checkpoints: () => ledger(1, [{ turn: 1, path: "src/parser.ts", at: new Date().toISOString(), tool: "write_file" }]),
    });
    const sink = collect();

    await finishRunVerification(port, { runId: "run_6", objective: goal.objective, deliver: sink.deliver });

    expect(port.verdict("run_6")?.outcome).toBe("completed");
    expect(session.store.get(goal.id)?.status).toBe("completed");
    expect(sink.events).toEqual([]);
  });
});
