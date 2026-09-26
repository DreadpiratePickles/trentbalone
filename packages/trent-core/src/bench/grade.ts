/**
 * [C16] The bench's grader: the end state of the fake world, scored by the app's own weighted eval harness
 * (`evals/index.ts` over `apps/web/lib/eval-harness.ts`), never by a model.
 *
 * Two graders per task, both deterministic:
 *   state_check  the task's `observe(world)` must equal `expect` on every key (JSON equality, the harness's
 *                own rule), so "a booking exists at 14:00Z for CUST_JANE" is a fact read off the fake Square;
 *   tool_call    no operation in `forbidden` reached a fake (a refund, a second invoice).
 * The harness calls a fixture passed at a score of 0.8; the bench requires 1, every grader holding, because
 * a partial end state (the booking at the wrong time) is a failed task for the owner.
 *
 * `checks` repeats the same comparisons key by key so a reader can see WHICH fact was wrong; the verdict is
 * the harness's score, and the two agree by construction (same equality).
 */
import { runEvalSuite, type EvalGrader } from "../evals/index.js";
import type { BenchTask, GradeCheck, TaskGrade, WorldView } from "./types.js";

const shown = (value: unknown): string => (value === undefined ? "nothing" : JSON.stringify(value));

/** The task's projection of the world; a projection that throws is a failed check, not a crashed bench. */
function observed(task: BenchTask, world: WorldView): { state: Record<string, unknown>; error?: string } {
  try {
    return { state: task.observe(world) };
  } catch (error) {
    return { state: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function gradeTask(task: BenchTask, world: WorldView): Promise<TaskGrade> {
  const operations = [...world.operations];
  const { state, error } = observed(task, world);
  const graders: EvalGrader[] = [{ type: "state_check", weight: 1, expect: { ...task.expect } }];
  if (task.forbidden !== undefined && task.forbidden.length > 0) graders.push({ type: "tool_call", weight: 1, forbidden: [...task.forbidden] });
  const suite = await runEvalSuite({
    subjectType: "seat",
    subjectId: "bench",
    version: task.id,
    fixtures: [{ id: task.id, rubricId: task.id, input: task.objective, actual: { state, toolCalls: operations }, graders }],
  });
  const fixture = suite.fixtures[0];

  const checks: GradeCheck[] = Object.entries(task.expect).map(([name, expected]) => {
    const actual = state[name];
    const passed = JSON.stringify(actual) === JSON.stringify(expected);
    return { name, passed, detail: passed ? `is ${shown(actual)}` : `expected ${shown(expected)}, got ${shown(actual)}` };
  });
  if (error !== undefined) checks.push({ name: "observe", passed: false, detail: `the task's projection threw: ${error}` });
  if (task.forbidden !== undefined && task.forbidden.length > 0) {
    const hits = task.forbidden.filter((name) => operations.includes(name));
    checks.push({ name: "forbidden operations", passed: hits.length === 0, detail: hits.length === 0 ? `none of ${task.forbidden.join(", ")}` : `reached the fakes: ${hits.join(", ")}` });
  }
  const score = fixture?.score ?? 0;
  return { passed: score === 1 && error === undefined, score, checks, failureTags: fixture?.failureTags ?? [] };
}
