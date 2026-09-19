/**
 * D4 RED — goals, their gates, and what a gate decides.
 *
 * The three behaviours that make a gate a gate rather than a suggestion: green gates let the judge
 * speak, a red gate ends the run before the judge is asked and leaves its tail where the next run
 * will read it, and the continuation cap stops the goal from retrying for ever.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATE_TAIL_MAX_CHARS,
  GoalStore,
  continuationFor,
  finishGoalRun,
  gateCommandLine,
  markContinued,
  parseGateFlag,
  runGates,
  type GateBackend,
  type GoalGate,
  type GoalRecord,
} from "./index.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-goals-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/** A backend that answers by gate name; nothing here starts a process. */
function fakeBackend(answers: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): GateBackend & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async run(command) {
      seen.push(command);
      const key = Object.keys(answers).find((needle) => command.includes(needle));
      const answer = key === undefined ? { exitCode: 0 } : answers[key]!;
      return { exitCode: answer.exitCode, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", durationMs: 1 };
    },
  };
}

const TYPECHECK: GoalGate = { name: "typecheck", command: ["npx", "tsc", "--noEmit"] };
const TESTS: GoalGate = { name: "tests", command: ["npm", "test"] };

function openGoal(store: GoalStore, gates: readonly GoalGate[]): GoalRecord {
  return store.create({ objective: "Ship the parser", contract: "tsc and the suite are green", gates });
}

describe("the goal store", () => {
  it("writes a goal under <profileDir>/goals with 0700/0600 and reads it back", () => {
    const store = new GoalStore(profileDir);
    const goal = openGoal(store, [TYPECHECK]);
    expect(store.get(goal.id)?.objective).toBe("Ship the parser");
    expect(store.list().map((row) => row.id)).toEqual([goal.id]);
    expect(fs.statSync(store.root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(store.root, `${goal.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("refuses an id that would leave the goals directory", () => {
    const store = new GoalStore(profileDir);
    expect(() => store.get("../../etc/passwd")).toThrow(/not a safe/i);
  });
});

describe("a gate command", () => {
  it("is an argv quoted for the sandbox, never a shell string spliced together", () => {
    expect(gateCommandLine(["npm", "test", "-- --grep", "a'b"])).toBe(`'npm' 'test' '-- --grep' 'a'\\''b'`);
  });

  it("parses --gate name=<argv> from the command line", () => {
    expect(parseGateFlag("typecheck=npx tsc --noEmit")).toEqual({ name: "typecheck", command: ["npx", "tsc", "--noEmit"] });
    expect(() => parseGateFlag("typecheck=")).toThrow(/needs/i);
    expect(() => parseGateFlag("npx tsc")).toThrow(/name=/);
  });

  it("stops at the first red gate and bounds the tail it captures", async () => {
    const noise = "x".repeat(GATE_TAIL_MAX_CHARS * 2);
    const backend = fakeBackend({ tsc: { exitCode: 2, stdout: noise } });
    const results = await runGates([TYPECHECK, TESTS], backend);
    expect(results).toHaveLength(1);
    expect(results[0]?.exitCode).toBe(2);
    expect(results[0]?.tail.length).toBeLessThanOrEqual(GATE_TAIL_MAX_CHARS);
    expect(backend.seen).toHaveLength(1);
  });
});

describe("gates before judgment", () => {
  const verifyOff = { enabled: false, writes: [], evidence: [], commands: [] };

  it("consults the judge once every gate exits 0", async () => {
    const store = new GoalStore(profileDir);
    const goal = openGoal(store, [TYPECHECK, TESTS]);
    const asked: string[] = [];
    const verdict = await finishGoalRun({
      runId: "run_green",
      goal,
      backend: fakeBackend({}),
      store,
      verify: verifyOff,
      judge: async (input) => {
        asked.push(input.goal.id);
        return { done: true, reason: "the contract is met" };
      },
    });
    expect(verdict.outcome).toBe("completed");
    expect(verdict.judged).toBe(true);
    expect(asked).toEqual([goal.id]);
    expect(store.get(goal.id)?.status).toBe("completed");
  });

  it("never reaches the judge on a red gate, and leaves the tail for the next run", async () => {
    const store = new GoalStore(profileDir);
    const goal = openGoal(store, [TYPECHECK, TESTS]);
    let asked = 0;
    const verdict = await finishGoalRun({
      runId: "run_red",
      goal,
      backend: fakeBackend({ tsc: { exitCode: 2, stdout: "src/a.ts(3,1): error TS2304" } }),
      store,
      verify: verifyOff,
      judge: async () => {
        asked += 1;
        return { done: true, reason: "never asked" };
      },
    });
    expect(asked).toBe(0);
    expect(verdict.outcome).toBe("gated");
    expect(verdict.judged).toBe(false);
    expect(verdict.reason).toContain("typecheck");
    expect(verdict.reason).toContain("2");

    const stored = store.get(goal.id)!;
    expect(stored.status).toBe("gated");
    expect(stored.runs.at(-1)?.tail).toContain("TS2304");

    const next = continuationFor(stored, 3)!;
    expect(next.attempt).toBe(1);
    expect(next.objective).toBe(goal.objective);
    expect(next.history.map((message) => message.content).join("\n")).toContain("TS2304");
  });

  it("stops continuing at goals.max_continuations", () => {
    const store = new GoalStore(profileDir);
    let goal = openGoal(store, [TYPECHECK]);
    goal = store.save({ ...goal, status: "gated", runs: [{ run_id: "r", at: new Date().toISOString(), outcome: "gated", gate: "typecheck", exit_code: 1, tail: "red" }] });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const next = continuationFor(store.get(goal.id)!, 3);
      expect(next?.attempt).toBe(attempt);
      store.save(markContinued(store.get(goal.id)!));
      // The gate is still red, so the goal is gated again before the next continuation is asked for.
      store.save({ ...store.get(goal.id)!, status: "gated" });
    }
    expect(continuationFor(store.get(goal.id)!, 3)).toBeUndefined();
  });
});
