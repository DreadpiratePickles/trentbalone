/**
 * A3 — `todo`: the per-run task list Hermes has and Trent did not.
 *
 * The list is DURABLE on purpose. The run record is not: under Node every store the wrapper builds
 * is an `EphemeralStore` (`apps/cli/src/runtime/headless.ts`, AGENTS.md known defect 9), so a list
 * kept on the run vanishes with the process. This store writes the same way the session
 * transcripts do — atomic rename, owner-only mode — which is what "survives a store reopen" means.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { createTodoAdapter, TODO_ADAPTER_NAME, TodoStore } from "./index.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-todo-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const RUN = { runId: "run_a3", stepId: "step_1" };

describe("todo", () => {
  it("adds, updates and lists across two calls in one run", async () => {
    const adapter = createTodoAdapter({ profileDir });
    const summary = await runWithToolCallContext(RUN, async () => {
      const added = await adapter.execute('todo {"action":"add","items":["draft the migration","run the suite"]}', {});
      expect(added.status).toBe("completed");
      expect(added.adapter).toBe(TODO_ADAPTER_NAME);

      const ids = adapter.items(RUN.runId).map((item) => item.id);
      expect(ids).toHaveLength(2);

      const updated = await adapter.execute(`todo {"action":"update","id":${JSON.stringify(ids[0])},"status":"doing"}`, {});
      expect(updated.status).toBe("completed");

      const listed = await adapter.execute('todo {"action":"list"}', {});
      expect(listed.status).toBe("completed");
      return listed.summary;
    });

    expect(summary).toContain("draft the migration");
    expect(summary).toContain("doing");
    expect(summary).toContain("todo");
  });

  it("refuses a status the list does not have", async () => {
    const adapter = createTodoAdapter({ profileDir });
    const result = await runWithToolCallContext(RUN, async () => {
      await adapter.execute('todo {"action":"add","items":["one"]}', {});
      const id = adapter.items(RUN.runId)[0]?.id ?? "";
      return adapter.execute(`todo {"action":"update","id":${JSON.stringify(id)},"status":"almost"}`, {});
    });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("blocked");
  });

  it("survives a store reopen", async () => {
    const first = createTodoAdapter({ profileDir });
    await runWithToolCallContext(RUN, () => first.execute('todo {"action":"add","items":["survive the restart"]}', {}));

    const reopened = new TodoStore(profileDir);
    const items = reopened.list(RUN.runId);
    expect(items.map((item) => item.text)).toEqual(["survive the restart"]);
    expect(items[0]?.status).toBe("todo");

    // And the getter a surface renders from reads the same bytes back.
    const second = createTodoAdapter({ profileDir });
    expect(second.items(RUN.runId).map((item) => item.text)).toEqual(["survive the restart"]);
  });
});
