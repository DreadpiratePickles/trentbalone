/**
 * U5 / G9 — an approval over MCP is a durable row the founder settles with `trent approvals`,
 * bound to the call it previewed: same profile file (`gateway.json`), same bridge, same decision
 * path the CLI takes. A yes covers exactly one execution of exactly that call; a no sticks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalBridge, FileGatewayStore } from "../gateway/index.js";
import { approvalKey, createMcpApprovalGate, MCP_APPROVAL_SURFACE } from "./approvals.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-approvals-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const bridge = () => new ApprovalBridge({ store: new FileGatewayStore(path.join(profileDir, "gateway.json")) });

describe("approvalKey", () => {
  it("is stable for the same run, tool and arguments whatever the key order, and differs across runs and arguments", () => {
    const a = approvalKey("mcp_run_1", "write_file", { path: "a.txt", content: "x" });
    const b = approvalKey("mcp_run_1", "write_file", { content: "x", path: "a.txt" });
    expect(a).toBe(b);
    expect(approvalKey("mcp_run_2", "write_file", { path: "a.txt", content: "x" })).not.toBe(a);
    expect(approvalKey("mcp_run_1", "write_file", { path: "a.txt", content: "y" })).not.toBe(a);
    expect(a).toMatch(/^[a-f0-9]{16,}$/);
  });
});

describe("createMcpApprovalGate", () => {
  it("parks a pending row the CLI's bridge can decide, keyed to the call; approval settles it once, then it is spent", () => {
    const gate = createMcpApprovalGate({ profileDir, agentId: "mcp:claude-code", runId: "mcp_run_1" });
    const key = approvalKey("mcp_run_1", "write_file", { path: "a.txt", content: "x" });
    const parked = gate.request({ key, action: 'write_file {"path":"a.txt","content":"x"}', preview: "file_ops: would write a.txt" });
    expect(parked.status).toBe("pending");
    expect(parked.id).toMatch(/^appr_/);
    // Asking again for the same call returns the same row, not a second one.
    expect(gate.lookup(key)).toMatchObject({ id: parked.id, status: "pending" });
    const rows = bridge().listPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: parked.id, agentId: "mcp:claude-code", action: 'write_file {"path":"a.txt","content":"x"}', runId: "mcp_run_1" });
    expect(rows[0]!.details).toMatchObject({ surface: MCP_APPROVAL_SURFACE, key, preview: "file_ops: would write a.txt" });

    bridge().decide(parked.id, "approved", "human");
    expect(gate.lookup(key)).toMatchObject({ id: parked.id, status: "approved" });
    gate.spend(parked.id);
    // Spent: the next identical call has to ask again, and gets a new row.
    expect(gate.lookup(key)).toBeUndefined();
    const again = gate.request({ key, action: 'write_file {"path":"a.txt","content":"x"}', preview: "file_ops: would write a.txt" });
    expect(again.id).not.toBe(parked.id);
    expect(again.status).toBe("pending");
  });

  it("a denied row stays denied for that call and no new row is opened for it", () => {
    const gate = createMcpApprovalGate({ profileDir, agentId: "mcp:codex", runId: "mcp_run_9" });
    const key = approvalKey("mcp_run_9", "terminal", { command: "git push" });
    const parked = gate.request({ key, action: 'terminal {"command":"git push"}', preview: "terminal: git push needs approval" });
    bridge().decide(parked.id, "denied", "human");
    expect(gate.lookup(key)).toMatchObject({ id: parked.id, status: "denied" });
    const repeat = gate.request({ key, action: 'terminal {"command":"git push"}', preview: "terminal: git push needs approval" });
    expect(repeat).toMatchObject({ id: parked.id, status: "denied" });
    expect(Object.keys(new FileGatewayStore(path.join(profileDir, "gateway.json")).snapshot().approvals)).toHaveLength(1);
  });

  it("never writes a value that is not the call itself: the preview is what the adapter said", () => {
    const gate = createMcpApprovalGate({ profileDir, agentId: "mcp:grok", runId: "mcp_run_2" });
    const key = approvalKey("mcp_run_2", "memory", { target: "memory", content: "note" });
    gate.request({ key, action: 'memory {"target":"memory","content":"note"}', preview: "memory: would append to the memory block" });
    const text = fs.readFileSync(path.join(profileDir, "gateway.json"), "utf8");
    expect(text).toContain("would append");
    expect(fs.statSync(path.join(profileDir, "gateway.json")).mode & 0o777).toBe(0o600);
  });
});
