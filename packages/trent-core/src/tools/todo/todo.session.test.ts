/**
 * [C12] The todo list of a solo CONVERSATION outlives the message that wrote it (council C12; Hermes
 * `tools/todo_tool.py`: one list per agent session, re-read after compaction).
 *
 * A solo run is one message, so a list keyed by the run id was empty again on the next message. The key is now the
 * conversation's when the call runs bound to one: the binding the memory tool's owner check reads
 * (`governance/provenance.ts` `currentSessionTaint`, `tools/memory/index.ts` `writerOfCall`). A call bound to no
 * conversation (every fleet seat's) keeps today's per-run list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindSessionTaint, createSessionTaint, unbindSessionTaint, type SessionTaint } from "../../governance/provenance.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { createTodoAdapter } from "./index.js";

let profileDir: string;
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-todo-c12-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/** One call as a run of `taint`'s conversation makes it (the solo runner binds every run it drives). */
async function asRun<T>(runId: string, taint: SessionTaint | undefined, fn: () => Promise<T>): Promise<T> {
  if (taint !== undefined) bindSessionTaint(runId, taint);
  try {
    return await runWithToolCallContext({ runId, stepId: `${runId}-trent` }, fn);
  } finally {
    if (taint !== undefined) unbindSessionTaint(runId);
  }
}

const ADD = 'todo {"action":"add","items":["draft the catalogue","price the oak tables"]}';
const LIST = 'todo {"action":"list"}';

describe("[C12] todo: keyed by the conversation when the call is bound to one", () => {
  it("a list written in one run of a conversation is listed unchanged by a later run of it", async () => {
    const adapter = createTodoAdapter({ profileDir, now: () => "2026-09-26T09:00:00.000Z" });
    const conversation = createSessionTaint(undefined, "sess_c12");
    const added = await asRun("solo_1", conversation, () => adapter.execute(ADD, {}));
    await asRun("solo_2", conversation, () => adapter.execute('todo {"action":"update","id":"t1","status":"doing"}', {}));
    const listed = await asRun("solo_3", conversation, () => adapter.execute(LIST, {}));

    expect(added.status).toBe("completed");
    expect(listed.summary).toBe(["tasks: 1 todo, 1 doing", "t1 [doing] draft the catalogue", "t2 [todo] price the oak tables"].join("\n"));
    // The same conversation reopened by a new process (a new taint object, the same session id) reads the same list.
    const reopened = createTodoAdapter({ profileDir });
    expect((await asRun("solo_4", createSessionTaint(undefined, "sess_c12"), () => reopened.execute(LIST, {}))).summary).toBe(listed.summary);
  });

  it("another conversation has its own list", async () => {
    const adapter = createTodoAdapter({ profileDir });
    await asRun("solo_1", createSessionTaint(undefined, "sess_a"), () => adapter.execute(ADD, {}));
    const other = await asRun("solo_2", createSessionTaint(undefined, "sess_b"), () => adapter.execute(LIST, {}));
    expect(other.summary).toMatch(/is empty/);
  });

  it("a call bound to no conversation (a fleet seat's) keeps the per-run list, unchanged", async () => {
    const adapter = createTodoAdapter({ profileDir });
    await asRun("run_fleet_1", undefined, () => adapter.execute(ADD, {}));
    expect(adapter.items("run_fleet_1").map((item) => item.text)).toEqual(["draft the catalogue", "price the oak tables"]);
    const next = await asRun("run_fleet_2", undefined, () => adapter.execute(LIST, {}));
    expect(next.summary).toBe("the task list for this run is empty; add the steps you intend to take.");
  });
});
