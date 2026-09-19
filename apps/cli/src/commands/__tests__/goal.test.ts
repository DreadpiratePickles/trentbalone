/**
 * D4 — `trent goal create|list|show|continue`.
 *
 * The store is a real one on a temporary profile; the runtime `continue` needs is the fake behind
 * `ctx.overrides.gatewayRuntime`, the same seam `trent run`, `cron run` and `gateway start` use, so
 * nothing here reaches a model, a proxy or a sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { GoalStore, openGoalSession, closeGoalSession, type GoalSession } from "@trent/core/goals/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

let home: string;
let profileDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-goal-"));
  process.env.TRENT_HOME = home;
  profileDir = new ConfigManager({ profile: "default" }).getProfileDir();
});

afterEach(() => {
  closeGoalSession();
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const EVENTS: OrcEvent[] = [
  { kind: "run_start", runId: "run_goal", at: "2026-09-18T10:00:00.000Z" } as OrcEvent,
  { kind: "step_note", runId: "run_goal", at: "2026-09-18T10:00:01.000Z", detail: "The quality gate typecheck exited 2" } as OrcEvent,
  { kind: "run_done", runId: "run_goal", at: "2026-09-18T10:00:02.000Z", run: { status: "completed", summary: "done" } } as OrcEvent,
];

interface Fakes {
  readonly overrides: CliOverrides;
  readonly runs: { objective: string; history: readonly { role: string; content: string }[] }[];
  readonly cleanup: ReturnType<typeof vi.fn>;
  session(): GoalSession;
}

function fakes(): Fakes {
  const runs: Fakes["runs"] = [];
  const cleanup = vi.fn(async () => undefined);
  let session: GoalSession | undefined;
  const overrides: CliOverrides = {
    gatewayRuntime: async () => {
      session ??= openGoalSession({ profileDir });
      return {
        goals: session,
        run: (objective: string, options: { history?: readonly { role: string; content: string }[] } = {}) => {
          runs.push({ objective, history: options.history ?? [] });
          return (async function* () {
            for (const event of EVENTS) yield event;
          })();
        },
        cleanup,
      } as unknown as HeadlessRuntime;
    },
  };
  return { overrides, runs, cleanup, session: () => session! };
}

describe("trent goal", () => {
  it("creates a goal with its gates and lists it", async () => {
    const created = await runCli(["goal", "create", "Ship the parser", "--gate", "typecheck=npx tsc --noEmit", "--json"]);
    expect(created.exitCode).toBe(0);
    const id = (JSON.parse(created.stdout) as { id: string }).id;

    const store = new GoalStore(profileDir);
    expect(store.get(id)?.gates).toEqual([{ name: "typecheck", command: ["npx", "tsc", "--noEmit"] }]);

    const listed = await runCli(["goal", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ goals: [{ id, objective: "Ship the parser", status: "open" }] });
  });

  it("refuses a --gate it cannot read, with a non-zero exit code", async () => {
    const out = await runCli(["goal", "create", "Ship it", "--gate", "npx tsc", "--json"]);
    expect(out.exitCode).not.toBe(0);
    expect(new GoalStore(profileDir).list()).toHaveLength(0);
  });

  it("shows a goal's gates and its run history", async () => {
    const store = new GoalStore(profileDir);
    const goal = store.create({ objective: "Ship the parser", gates: [{ name: "tests", command: ["npm", "test"] }] });
    store.save({ ...goal, status: "gated", runs: [{ run_id: "run_1", at: "2026-09-18T09:00:00.000Z", outcome: "gated", gate: "tests", exit_code: 1, tail: "2 failed" }] });

    const shown = await runCli(["goal", "show", goal.id, "--json"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: goal.id, status: "gated", gates: [{ name: "tests" }], runs: [{ gate: "tests", exit_code: 1 }] });
  });

  it("continues a gated goal on the real runtime, carrying the red gate's tail as history", async () => {
    const store = new GoalStore(profileDir);
    const goal = store.create({ objective: "Ship the parser", gates: [{ name: "tests", command: ["npm", "test"] }] });
    store.save({ ...goal, status: "gated", runs: [{ run_id: "run_1", at: "2026-09-18T09:00:00.000Z", outcome: "gated", gate: "tests", exit_code: 1, tail: "src/a.ts(1,1): error TS2304" }] });

    const f = fakes();
    const out = await runCli(["goal", "continue", goal.id, "--json"], { overrides: f.overrides });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ id: goal.id, attempt: 1, objective: "Ship the parser" });
    expect(f.runs).toHaveLength(1);
    expect(f.runs[0]?.history.map((message) => message.content).join("\n")).toContain("TS2304");
    expect(f.session().store.get(goal.id)?.continuations).toBe(1);
    expect(f.cleanup).toHaveBeenCalled();
  });

  it("refuses a continuation past goals.max_continuations, without building a runtime", async () => {
    const store = new GoalStore(profileDir);
    const goal = store.create({ objective: "Ship the parser" });
    store.save({ ...goal, status: "gated", continuations: 3, runs: [{ run_id: "r", at: "2026-09-18T09:00:00.000Z", outcome: "gated", gate: "tests", exit_code: 1, tail: "still red" }] });

    const f = fakes();
    const out = await runCli(["goal", "continue", goal.id, "--json"], { overrides: f.overrides });
    expect(out.exitCode).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/max_continuations/);
    expect(f.runs).toHaveLength(0);
  });

  it("answers a dry run without touching the store or a runtime", async () => {
    const f = fakes();
    const created = await runCli(["goal", "create", "Ship it", "--json", "--dry-run"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ dryRun: true });
    expect(new GoalStore(profileDir).list()).toHaveLength(0);

    const continued = await runCli(["goal", "continue", "goal_missing", "--json", "--dry-run"], { overrides: f.overrides });
    expect(continued.exitCode).toBe(0);
    expect(JSON.parse(continued.stdout)).toMatchObject({ dryRun: true, id: "goal_missing" });
    expect(f.runs).toHaveLength(0);
  });
});
