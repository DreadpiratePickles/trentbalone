/**
 * `delegate_task`: an alias over the orchestrator's real delegation path. The tool never runs an
 * agent loop; it hands `{task, agent?, context?}` to an injected `DelegatePort` and returns the
 * child's result, statuses untouched.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDelegateAdapter, DELEGATE_ADAPTER_NAME, DELEGATE_TOOL_SCHEMAS } from "./index.js";
import type { DelegatePort, DelegateRequest, DelegateResult } from "./types.js";

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-delegate-"));

function fakePort(result: DelegateResult): DelegatePort & { calls: DelegateRequest[] } {
  const calls: DelegateRequest[] = [];
  return {
    calls,
    async delegate(request) {
      calls.push(request);
      return result;
    },
  };
}

describe("delegate_task", () => {
  it("advertises Hermes's delegate_task with tasks[].goal", () => {
    const schema = DELEGATE_TOOL_SCHEMAS.find((s) => s.name === "delegate_task");
    expect(schema).toBeDefined();
    const tasks = schema!.parameters.properties.tasks as { items: { required: string[]; properties: Record<string, unknown> } };
    expect(tasks.items.required).toEqual(["goal"]);
    expect(Object.keys(tasks.items.properties)).toEqual(expect.arrayContaining(["goal", "context", "agent"]));
  });

  it("calls the port with the exact args and surfaces the child's blocked memory write unchanged", async () => {
    const port = fakePort({
      status: "completed",
      output: "Child finished: the README lists three commands.",
      agent: "eng-ai-engineer",
      runId: "run_child_1",
      toolCalls: [
        { adapter: "memory", action: 'memory {"target":"memory","operations":[{"action":"add","content":"x"}]}', status: "blocked", summary: "This seat is delegated and has read-only memory. Report the fact to the parent instead." },
        { adapter: "file_ops", action: 'read_file {"path":"README.md"}', status: "completed", summary: "# Trent" },
      ],
    });
    const adapter = createDelegateAdapter({ profileDir, port });
    const action = `delegate_task ${JSON.stringify({ tasks: [{ goal: "Summarise README.md", context: "Repo at /workspace", agent: "eng-ai-engineer" }] })}`;
    const rec = await adapter.execute(action, {});
    expect(port.calls).toEqual([{ task: "Summarise README.md", context: "Repo at /workspace", agent: "eng-ai-engineer" }]);
    expect(rec.adapter).toBe(DELEGATE_ADAPTER_NAME);
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("Child finished: the README lists three commands.");
    expect(rec.summary).toContain("run_child_1");
    expect(rec.summary).toMatch(/memory[^\n]*\bblocked\b/);
    expect(rec.summary).toContain("This seat is delegated and has read-only memory.");
    expect(rec.summary).not.toMatch(/memory[^\n]*\bcompleted\b/);
  });

  it("accepts Hermes's legacy single-goal shape and omits optional fields it was not given", async () => {
    const port = fakePort({ status: "failed", output: "child hit its step cap" });
    const adapter = createDelegateAdapter({ profileDir, port });
    const rec = await adapter.execute('delegate_task {"goal":"Count the tests"}', {});
    expect(port.calls).toEqual([{ task: "Count the tests" }]);
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("child hit its step cap");
  });

  it("without a port returns a clear not_available error and does not pretend", async () => {
    const adapter = createDelegateAdapter({ profileDir });
    const rec = await adapter.execute('delegate_task {"tasks":[{"goal":"anything"}]}', {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("not_available");
    expect(rec.summary).not.toMatch(/completed|result/i);
    expect(await adapter.healthCheck()).toBe("needs_credentials");
  });

  it("refuses an empty task list and a goal that is not a string", async () => {
    const port = fakePort({ status: "completed", output: "never" });
    const adapter = createDelegateAdapter({ profileDir, port });
    expect((await adapter.execute('delegate_task {"tasks":[]}', {})).status).toBe("failed");
    expect((await adapter.execute('delegate_task {"tasks":[{"goal":42}]}', {})).status).toBe("failed");
    expect(port.calls).toEqual([]);
  });

  // [C5] Trust escalation is the named failure mode: a child's answer must not arrive at the
  // parent cleaner than the page it was read off.
  it("marks its record untrusted when any child tool call was untrusted, and says so in the body", async () => {
    const port = fakePort({
      status: "completed",
      output: "the vendor page lists net-30 terms",
      toolCalls: [
        { adapter: "file_ops", action: "read_file", status: "completed", summary: "read notes.md", provenance: "trusted" },
        { adapter: "web", action: "web_extract", status: "completed", summary: "fetched the vendor page", provenance: "untrusted" },
      ],
    });
    const adapter = createDelegateAdapter({ profileDir, port });
    const rec = await adapter.execute('delegate_task {"goal":"read the vendor page"}', {});
    expect(rec.provenance).toBe("untrusted");
    expect(rec.summary).toContain("untrusted");
    expect(rec.summary).toContain("web_extract");
  });

  it("stays trusted when every child tool call was trusted", async () => {
    const port = fakePort({
      status: "completed",
      output: "the repository has 41 packages",
      toolCalls: [{ adapter: "file_ops", action: "read_file", status: "completed", summary: "read package.json", provenance: "trusted" }],
    });
    const adapter = createDelegateAdapter({ profileDir, port });
    const rec = await adapter.execute('delegate_task {"goal":"count the packages"}', {});
    expect(rec.provenance).toBe("trusted");
    expect(rec.summary).not.toContain("untrusted");
  });

  it("a port failure becomes a failed record, not a throw", async () => {
    const port: DelegatePort = { delegate: async () => { throw new Error("orchestrator offline"); } };
    const adapter = createDelegateAdapter({ profileDir, port });
    const rec = await adapter.execute('delegate_task {"goal":"x"}', {});
    expect(rec.status).toBe("failed");
    expect(rec.summary).toContain("orchestrator offline");
  });
});
