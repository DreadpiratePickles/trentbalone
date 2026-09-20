import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildTrentTools } from "../tools/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { IdempotencyManager } from "./IdempotencyManager.js";
import { idempotentAdapters, isSideEffecting } from "./idempotent-dispatch.js";
import { runWithToolCallContext } from "./tool-call-context.js";

function fakeAdapter(name: string, scopes: string[], calls: string[]): TrentToolAdapter {
  return {
    name,
    scopes,
    availability: "real",
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => {
      calls.push(action);
      return { adapter: name, action, status: "completed", summary: `${name} ran ${calls.length} time(s)` };
    },
    cleanup: async () => undefined,
  };
}

const STEP = { runId: "run_a", stepId: "step_1" };

describe("idempotent tool dispatch", () => {
  it("classifies the scope vocabulary: write, execute, send and network are side effects; reads are not", () => {
    expect(isSideEffecting("file_ops", "write_file")).toBe(true);
    expect(isSideEffecting("file_ops", "patch")).toBe(true);
    expect(isSideEffecting("terminal", "terminal")).toBe(true);
    expect(isSideEffecting("code_execution", "execute_code")).toBe(true);
    expect(isSideEffecting("email", "send_message")).toBe(true);
    expect(isSideEffecting("http", "network_request")).toBe(true);
    expect(isSideEffecting("file_ops", "read_file")).toBe(false);
    expect(isSideEffecting("file_ops", "search_files")).toBe(false);
    expect(isSideEffecting("web", "web_search")).toBe(false);
    expect(isSideEffecting("vision", "vision_analyze")).toBe(false);
  });

  // [U1] G3: the vocabulary of the executors that post, send, book, invoice or charge.
  it("names publish, post, reply, book, invoice, charge, pay, sms, refund and email as side effects", () => {
    for (const [adapter, tool] of [
      ["social", "publish_post"], ["social", "post_update"], ["social", "reply_comment"], ["calendar", "book_slot"],
      ["billing", "create_invoice"], ["billing", "charge_card"], ["billing", "pay_invoice"], ["twilio", "sms"],
      ["billing", "refund_charge"], ["mail", "email"],
    ] as const) {
      expect(isSideEffecting(adapter, tool), `${adapter}:${tool}`).toBe(true);
    }
    expect(isSideEffecting("social", "list_mentions")).toBe(false);
    expect(isSideEffecting("calendar", "list_slots")).toBe(false);
  });

  it("a second identical call in one step per token family returns the first result without a second send", async () => {
    for (const [name, tool] of [
      ["social", "publish_post"], ["social", "post_update"], ["social", "reply_comment"], ["calendar", "book_slot"],
      ["billing", "create_invoice"], ["billing", "charge_card"], ["billing", "pay_invoice"], ["twilio", "sms"],
      ["billing", "refund_charge"], ["mail", "email"],
    ] as const) {
      const calls: string[] = [];
      const [adapter] = idempotentAdapters([fakeAdapter(name, [name, tool], calls)], new IdempotencyManager());
      const action = `${tool} {"target":"t1","body":"hello"}`;
      const [first, second] = await runWithToolCallContext(STEP, async () => [await adapter.execute(action, {}), await adapter.execute(action, {})]);
      expect(calls, `${name}:${tool}`).toEqual([action]);
      expect(second, `${name}:${tool}`).toEqual(first);
    }
  });

  it("a read-scope tool called twice executes twice and records nothing", async () => {
    const calls: string[] = [];
    const manager = new IdempotencyManager();
    const [adapter] = idempotentAdapters([fakeAdapter("file_ops", ["file_ops", "read_file", "write_file"], calls)], manager);
    await runWithToolCallContext(STEP, async () => {
      await adapter.execute('read_file {"path":"a.txt"}', {});
      await adapter.execute('read_file {"path":"a.txt"}', {});
    });
    expect(calls).toHaveLength(2);
    expect(manager.listRecords()).toEqual([]);
  });

  it("a write-scope tool called twice with identical args in the same run/step executes once", async () => {
    const calls: string[] = [];
    const manager = new IdempotencyManager();
    const [adapter] = idempotentAdapters([fakeAdapter("file_ops", ["file_ops", "read_file", "write_file"], calls)], manager);
    const [first, second] = await runWithToolCallContext(STEP, async () => [
      await adapter.execute('write_file {"path":"a.txt","content":"x"}', {}),
      await adapter.execute('write_file {"path":"a.txt","content":"x"}', {}),
    ]);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(manager.listRecords()).toHaveLength(1);
  });

  it("different args, a different step or no step context are separate executions", async () => {
    const calls: string[] = [];
    const manager = new IdempotencyManager();
    const [adapter] = idempotentAdapters([fakeAdapter("terminal", ["terminal"], calls)], manager);
    await runWithToolCallContext(STEP, async () => {
      await adapter.execute('terminal {"command":"ls"}', {});
      await adapter.execute('terminal {"command":"ls -la"}', {});
    });
    await runWithToolCallContext({ runId: "run_a", stepId: "step_2" }, () => adapter.execute('terminal {"command":"ls"}', {}));
    // Outside a seat turn there is no run/step to key on, so the call goes straight through.
    await adapter.execute('terminal {"command":"ls"}', {});
    expect(calls).toHaveLength(4);
    expect(manager.listRecords()).toHaveLength(3);
  });

  it("does not cache a needs_approval or failed record as the final answer", async () => {
    let status: "needs_approval" | "completed" | "failed" = "needs_approval";
    const calls: string[] = [];
    const adapter: TrentToolAdapter = {
      ...fakeAdapter("file_ops", ["write_file"], calls),
      execute: async (action) => {
        calls.push(action);
        return { adapter: "file_ops", action, status, summary: status };
      },
    };
    const manager = new IdempotencyManager();
    const [wrapped] = idempotentAdapters([adapter], manager);
    await runWithToolCallContext(STEP, async () => {
      expect((await wrapped.execute('write_file {"path":"a"}', {})).status).toBe("needs_approval");
      status = "failed";
      expect((await wrapped.execute('write_file {"path":"a"}', {})).status).toBe("failed");
      status = "completed";
      expect((await wrapped.execute('write_file {"path":"a"}', {})).status).toBe("completed");
      expect((await wrapped.execute('write_file {"path":"a"}', {})).status).toBe("completed");
    });
    expect(calls).toHaveLength(3);
  });

  it("keeps the adapter's other members intact, including live getters", () => {
    const calls: string[] = [];
    const base = fakeAdapter("mcp", [], calls);
    let live = ["mcp"];
    Object.defineProperty(base, "scopes", { get: () => live, enumerable: true });
    const [wrapped] = idempotentAdapters([base], new IdempotencyManager());
    live = ["mcp", "server__tool"];
    expect(wrapped.scopes).toEqual(["mcp", "server__tool"]);
    expect(wrapped.name).toBe("mcp");
    expect(wrapped.instructions).toBe("");
  });
});

describe("buildTrentTools dispatches through the profile's idempotency manager", () => {
  it("a write_file repeated in one step lands once on disk and once in <profile>/idempotency.json", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-idempotent-build-"));
    const profileDir = path.join(root, "profile");
    try {
      const { adapters } = buildTrentTools({ toolsets: ["file_ops"], disabled_toolsets: [] }, { workspace: root, profileDir, backend: "local", autoApproveWrites: true });
      const [fileOps] = adapters;
      const write = 'write_file {"path":"notes.txt","content":"once"}';
      const [first, second] = await runWithToolCallContext({ runId: "run_b", stepId: "step_9" }, async () => [
        await fileOps.execute(write, {}),
        await fileOps.execute(write, {}),
      ]);
      expect(first.status).toBe("completed");
      expect(second).toEqual(first);
      expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("once");
      const persisted = JSON.parse(fs.readFileSync(path.join(profileDir, "idempotency.json"), "utf8")) as { records: Record<string, { status: string }> };
      expect(Object.values(persisted.records).map((row) => row.status)).toEqual(["completed"]);
      // The read that follows is never recorded.
      await runWithToolCallContext({ runId: "run_b", stepId: "step_9" }, () => fileOps.execute('read_file {"path":"notes.txt"}', {}));
      expect(Object.keys((JSON.parse(fs.readFileSync(path.join(profileDir, "idempotency.json"), "utf8")) as { records: object }).records)).toHaveLength(1);
      await Promise.all(adapters.map((a) => a.cleanup()));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
