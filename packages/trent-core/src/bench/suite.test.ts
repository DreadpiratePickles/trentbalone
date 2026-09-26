/**
 * [C16] Every `smb-20` task is solvable with Trent's own tools and its grader tells a done task from an
 * undone one: for each of the twenty, the world as seeded FAILS (doing nothing never passes), and the task's
 * reference calls, made through the bench's tool build (the shipped gate chain, the owner on top) against
 * the fakes, PASS. No model is involved: the reference calls are the ones a correct agent would make.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBoundApprovals } from "../governance/bound-approvals.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildToolCatalog } from "../mcp-server/catalog.js";
import { gradeTask } from "./grade.js";
import { createOperator } from "./operator.js";
import { fingerprint, selectTasks, SMB_20, suiteById } from "./suite.js";
import { buildBenchTools, type BenchTools } from "./tools.js";
import { TASK_CLASSES, type BenchTask } from "./types.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

let world: BenchWorld;
let tools: BenchTools;
let profileDir: string;
const operator = createOperator();

beforeAll(async () => {
  world = await startBenchWorld();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-profile-"));
  tools = buildBenchTools({ world, operator, profileDir });
});

afterAll(async () => {
  installBoundApprovals(undefined);
  for (const adapter of tools.adapters) await adapter.cleanup();
  await world.stop();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/** Each call as a host's would be dispatched (`mcp-server/server.ts`): a deferred tool through the bridge's `tool_call`. */
async function runReference(task: BenchTask): Promise<string[]> {
  const catalog = buildToolCatalog(tools.adapters);
  const statuses: string[] = [];
  for (const [index, call] of task.reference.entries()) {
    const entry = catalog.find((candidate) => candidate.name === call.tool);
    if (entry === undefined) throw new Error(`no bench tool is named ${call.tool}`);
    const action = entry.via === "bridge" ? `tool_call ${JSON.stringify({ name: call.tool, arguments: call.args })}` : `${call.tool} ${JSON.stringify(call.args)}`;
    const result = await runWithToolCallContext({ runId: `ref_${task.id}`, stepId: `step_${String(index)}` }, () => entry.target.execute(action, {}));
    statuses.push(`${call.tool}: ${result.status}${result.status === "completed" ? "" : ` (${result.summary})`}`);
  }
  return statuses;
}

describe("[C16] smb-20", () => {
  it("has twenty tasks with distinct ids, four in each of the five classes", () => {
    expect(SMB_20.tasks).toHaveLength(20);
    expect(new Set(SMB_20.tasks.map((task) => task.id)).size).toBe(20);
    for (const taskClass of TASK_CLASSES) expect(SMB_20.tasks.filter((task) => task.taskClass === taskClass), taskClass).toHaveLength(4);
    expect(suiteById("smb-20")).toBe(SMB_20);
    expect(fingerprint(SMB_20)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => selectTasks(SMB_20, ["no-such-task"])).toThrow(/no task no-such-task/);
  });

  for (const task of SMB_20.tasks) {
    it(`${task.id}: the seeded world fails, and the reference calls pass`, async () => {
      world.reset(task.seed);
      operator.begin(task, world.decisionLog);
      installBoundApprovals(tools.bindings);
      const untouched = await gradeTask(task, world);
      expect(untouched.passed, `${task.id} passes with nothing done`).toBe(false);

      const statuses = await runReference(task);
      expect(statuses.filter((line) => !line.endsWith(": completed")), task.id).toEqual([]);
      const done = await gradeTask(task, world);
      expect(done.checks.filter((check) => !check.passed), task.id).toEqual([]);
      expect(done.passed).toBe(true);
    });
  }
});
