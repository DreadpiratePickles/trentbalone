/**
 * [C16] The suites `trent bench run` knows. `smb-20` is the council's: twenty small-business tasks in five
 * classes of four, set in one spa (`fixtures/notes.ts`), each graded on the fake servers' end state.
 *
 * The suite is the protected evaluator of rulebook Phase 7: a change that makes a harness score better by
 * editing a fixture, a grader or `expect` is not an improvement. Its identity is its task ids in order plus
 * their `expect` records, hashed into `fingerprint`, which every report carries, so two reports are only
 * comparable when their fingerprints match.
 */
import crypto from "node:crypto";
import { BILLING_TASKS } from "./fixtures/billing.js";
import { BOOKING_TASKS } from "./fixtures/bookings.js";
import { FILE_TASKS } from "./fixtures/files.js";
import { GUARD_TASKS } from "./fixtures/guards.js";
import { MESSAGE_TASKS } from "./fixtures/messages.js";
import type { BenchSuite, BenchTask } from "./types.js";

export const SMB_20: BenchSuite = {
  id: "smb-20",
  title: "Twenty small-business tasks at one spa, graded on the fake servers' end state",
  tasks: [...BOOKING_TASKS, ...BILLING_TASKS, ...MESSAGE_TASKS, ...FILE_TASKS, ...GUARD_TASKS],
};

export const SUITES: readonly BenchSuite[] = [SMB_20];

export function suiteById(id: string): BenchSuite | undefined {
  return SUITES.find((suite) => suite.id === id);
}

/** The suite narrowed to `taskIds` (all when empty); an unknown id is refused, never skipped. */
export function selectTasks(suite: BenchSuite, taskIds: readonly string[]): readonly BenchTask[] {
  if (taskIds.length === 0) return suite.tasks;
  const unknown = taskIds.filter((id) => !suite.tasks.some((task) => task.id === id));
  if (unknown.length > 0) throw new Error(`${suite.id} has no task ${unknown.join(", ")}; its tasks are ${suite.tasks.map((task) => task.id).join(", ")}`);
  return suite.tasks.filter((task) => taskIds.includes(task.id));
}

/** A short hash of what the suite grades: task ids, objectives, owner policies, expectations and forbidden lists. */
export function fingerprint(suite: BenchSuite): string {
  const material = suite.tasks.map((task) => ({ id: task.id, objective: task.objective, approves: task.approves, expect: task.expect, forbidden: task.forbidden ?? [] }));
  return crypto.createHash("sha256").update(JSON.stringify({ id: suite.id, tasks: material })).digest("hex").slice(0, 16);
}
