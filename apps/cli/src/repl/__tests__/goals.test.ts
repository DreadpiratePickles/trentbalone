/**
 * D4 item 4 — `/goal` and `/goals` in the REPL.
 *
 * Same governing assertion as the rest of the command suite: mutate the state, re-run the command,
 * and the output must change. The state here is a real goal store on a real temporary profile, so
 * what is asserted is what landed on disk, never a string the command printed to itself.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { closeGoalSession, openGoalSession, type GoalSession } from "@trent/core/goals/index.js";
import { createTheme } from "../../ui/index.js";
import { ApprovalGate } from "../approvals.js";
import { BudgetLedger } from "../budget.js";
import { runCommand } from "../commands.js";
import type { ReplContext } from "../types.js";
import { MemoryStore } from "./harness.js";

const COMPANY = "cmp_goal";

let profileDir = "";
let session: GoalSession;
let ctx: ReplContext;

function makeContext(): ReplContext {
  const store = new MemoryStore();
  const config: TrentConfig = structuredClone(DEFAULT_CONFIG);
  return {
    theme: createTheme("none"),
    config,
    store,
    companyId: COMPANY,
    traces: { query: async () => [], byRun: async () => [] },
    budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
    approvals: new ApprovalGate(store, COMPANY),
    degraded: false,
  };
}

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-repl-goal-"));
  session = openGoalSession({ profileDir });
  ctx = makeContext();
});

afterEach(() => {
  closeGoalSession();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("/goal and /goals", () => {
  it("opens a goal with its gates, binds it to the session, and lists it", async () => {
    const before = await runCommand("goals", [], ctx);
    expect(before).toMatch(/no goal/i);

    const out = await runCommand("goal", ["Ship", "the", "parser", "--gate", "typecheck=npx tsc --noEmit"], ctx);
    const goal = session.store.list()[0]!;
    expect(goal.objective).toBe("Ship the parser");
    expect(goal.gates).toEqual([{ name: "typecheck", command: ["npx", "tsc", "--noEmit"] }]);
    expect(session.activeGoalId).toBe(goal.id);
    expect(out).toContain(goal.id);

    const after = await runCommand("goals", [], ctx);
    expect(after).toContain("Ship the parser");
    expect(after).toContain("typecheck");
    expect(after).not.toBe(before);
  });

  it("takes more than one --gate, in the order they were given", async () => {
    await runCommand("goal", ["Ship", "it", "--gate", "types=npx tsc", "--gate", "tests=npm test"], ctx);
    expect(session.store.list()[0]?.gates.map((gate) => gate.name)).toEqual(["types", "tests"]);
  });

  it("reports a --gate it cannot read instead of opening a goal with no gate", async () => {
    const out = await runCommand("goal", ["Ship", "it", "--gate", "npx tsc"], ctx);
    expect(out).toMatch(/name=/);
    expect(session.store.list()).toHaveLength(0);
  });

  it("continues a gated goal, carrying the red gate's tail into the next run's history", async () => {
    const goal = session.store.create({ objective: "Ship the parser", gates: [{ name: "typecheck", command: ["npx", "tsc"] }] });
    session.store.save({
      ...goal,
      status: "gated",
      runs: [{ run_id: "run_1", at: new Date().toISOString(), outcome: "gated", gate: "typecheck", exit_code: 2, tail: "src/a.ts(1,1): error TS2304" }],
    });

    const out = await runCommand("goal", ["continue", goal.id], ctx);
    expect(out).toContain("TS2304");
    expect(session.activeGoalId).toBe(goal.id);
    expect(session.store.get(goal.id)?.continuations).toBe(1);
  });

  it("refuses a continuation past goals.max_continuations", async () => {
    const goal = session.store.create({ objective: "Ship the parser" });
    session.store.save({
      ...goal,
      status: "gated",
      continuations: session.config.max_continuations,
      runs: [{ run_id: "run_1", at: new Date().toISOString(), outcome: "gated", gate: "typecheck", exit_code: 2, tail: "still red" }],
    });

    const out = await runCommand("goal", ["continue", goal.id], ctx);
    expect(out).toMatch(/max_continuations/);
    expect(session.store.get(goal.id)?.continuations).toBe(session.config.max_continuations);
  });

  it("says plainly that there is no goal session rather than pretending there is", async () => {
    closeGoalSession();
    expect(await runCommand("goals", [], ctx)).toMatch(/no goal session/i);
  });
});
