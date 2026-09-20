/**
 * U5 / G9 — `trent mcp serve` as an MCP client sees it, driven through the SDK's own client
 * (in-process over `InMemoryTransport`; the stdio proof is `stdio.test.ts`). Every call crosses
 * the same wrapper chain a seat's call crosses: a hardline command is refused before any adapter
 * sees it, a gated call is parked as an approval the founder settles with `trent approvals`, and a
 * result is scrubbed of secrets the way an MCP result reaching a seat is.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalBridge, FileGatewayStore } from "../gateway/index.js";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";
import { record as toRecord } from "../tools/action.js";
import { buildTrentTools } from "../tools/index.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { renderToolInstructions, type ToolSchema } from "../tools/web/schemas.js";
import { createTrentMcpServer, type TrentMcpServer } from "./server.js";

let home: string;
let workspace: string;
let profileDir: string;
let built: ReturnType<typeof buildTrentTools> | undefined;
let server: TrentMcpServer | undefined;
let client: Client | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-server-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-server-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  for (const adapter of built?.adapters ?? []) await adapter.cleanup();
  client = undefined;
  server = undefined;
  built = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const ECHO_SCHEMA: ToolSchema = {
  name: "brain_echo",
  description: "Echo the text back, as a fake brain reader would.",
  parameters: { type: "object", properties: { text: { type: "string", description: "What to echo." } }, required: ["text"] },
};

/** A fake adapter that answers like a read of the brain would, and can leak a secret on request. */
function fakeBrain(seen: string[]): TrentToolAdapter {
  return {
    name: "brain_read",
    scopes: ["brain_read", "brain_echo"],
    availability: "real",
    instructions: renderToolInstructions([ECHO_SCHEMA]),
    routingText: "fake brain",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    async execute(action): Promise<ToolCallRecord> {
      seen.push(action);
      const args = JSON.parse(action.slice(action.indexOf("{"))) as { text?: string };
      const text = args.text ?? "";
      if (text === "leak") return toRecord("brain_read", action, "completed", "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ and that is all");
      return toRecord("brain_read", action, "completed", `echo: ${text}`);
    },
    cleanup: async () => undefined,
  };
}

async function open(seen: string[], config: Record<string, unknown> = {}): Promise<{ client: Client; server: TrentMcpServer }> {
  built = buildTrentTools(
    { toolsets: ["file_ops", "terminal"], disabled_toolsets: [], ...config },
    { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager({ dir: profileDir }), extraAdapters: [fakeBrain(seen)] },
  );
  server = createTrentMcpServer({ adapters: built.adapters, profileDir, companyId: "cmp_test" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "fake-host", version: "0.0.1" });
  await client.connect(clientSide);
  return { client, server };
}

function textOf(result: unknown): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? raw : [];
  return content.map((item) => (typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")).join("\n");
}

describe("trent mcp serve", () => {
  it("lists one MCP tool per Trent tool of the enabled toolsets, the brain tools included, and no bridge or founder prompt", async () => {
    const { client } = await open([]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["read_file", "write_file", "patch", "search_files", "terminal", "process_manage", "brain_echo", "todo", "session_search"]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
    for (const absent of ["tool_call", "tool_search", "tool_describe", "ask_human", "clarify", "web_search"]) expect(names).not.toContain(absent);
    const terminal = tools.find((tool) => tool.name === "terminal")!;
    expect(terminal.inputSchema).toMatchObject({ type: "object", required: ["command"] });
    expect((terminal.inputSchema.properties as Record<string, unknown>).command).toBeDefined();
  });

  it("a call reaches the adapter with the composed action and comes back as text plus structured content", async () => {
    const seen: string[] = [];
    const { client, server } = await open(seen);
    const result = await client.callTool({ name: "brain_echo", arguments: { text: "hello brain" } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("echo: hello brain");
    expect(result.structuredContent).toMatchObject({ status: "completed", tool: "brain_echo", adapter: "brain_read", surface: "mcp" });
    expect(seen).toEqual(['brain_echo {"text":"hello brain"}']);
    expect(server.runId).toMatch(/^mcp_/);
    expect(server.surface).toBe("mcp");
  });

  it("refuses a hardline command as blocked before any adapter runs, with the rule named, at the level that lifts everything else", async () => {
    const { client } = await open([], { autonomy: "never" });
    const result = await client.callTool({ name: "terminal", arguments: { command: "rm -rf /" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("recursive-delete-of-root-home-or-profile");
    expect(result.structuredContent).toMatchObject({ status: "blocked", tool: "terminal" });
  });

  it("parks a gated call as needs_approval with the id and preview; the founder's yes runs it once; the next identical call asks again", async () => {
    const { client, server } = await open([]);
    const args = { path: "notes/hello.txt", content: "written over MCP" };
    const first = await client.callTool({ name: "write_file", arguments: args });
    expect(first.isError).toBeFalsy();
    const structured = first.structuredContent as { status: string; approval_id: string; preview: string; settle: string };
    expect(structured.status).toBe("needs_approval");
    expect(structured.approval_id).toMatch(/^appr_/);
    expect(structured.preview.length).toBeGreaterThan(0);
    expect(structured.settle).toContain(`trent approvals approve ${structured.approval_id}`);
    expect(textOf(first)).toContain(structured.approval_id);
    expect(fs.existsSync(path.join(workspace, "notes", "hello.txt"))).toBe(false);

    // Same call again while pending: the same row, not a second one.
    const again = await client.callTool({ name: "write_file", arguments: args });
    expect((again.structuredContent as { approval_id: string }).approval_id).toBe(structured.approval_id);

    const bridge = new ApprovalBridge({ store: new FileGatewayStore(path.join(profileDir, "gateway.json")) });
    const row = bridge.getApproval(structured.approval_id)!;
    expect(row.runId).toBe(server.runId);
    expect(row.agentId).toBe("mcp:fake-host");
    bridge.decide(structured.approval_id, "approved", "human");

    const executed = await client.callTool({ name: "write_file", arguments: args });
    expect(executed.isError).toBeFalsy();
    expect(executed.structuredContent).toMatchObject({ status: "completed" });
    expect(fs.readFileSync(path.join(workspace, "notes", "hello.txt"), "utf8")).toBe("written over MCP");

    const spent = await client.callTool({ name: "write_file", arguments: args });
    const next = spent.structuredContent as { status: string; approval_id: string };
    expect(next.status).toBe("needs_approval");
    expect(next.approval_id).not.toBe(structured.approval_id);
  });

  it("keeps a founder's no: the same call is blocked, not re-asked", async () => {
    const { client } = await open([]);
    const args = { path: "no.txt", content: "never" };
    const first = await client.callTool({ name: "write_file", arguments: args });
    const id = (first.structuredContent as { approval_id: string }).approval_id;
    new ApprovalBridge({ store: new FileGatewayStore(path.join(profileDir, "gateway.json")) }).decide(id, "denied", "human");
    const denied = await client.callTool({ name: "write_file", arguments: args });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({ status: "blocked", approval_id: id });
    expect(fs.existsSync(path.join(workspace, "no.txt"))).toBe(false);
  });

  it("scrubs secret-shaped runs out of a result the way an MCP result reaching a seat is scrubbed", async () => {
    const { client } = await open([]);
    const result = await client.callTool({ name: "brain_echo", arguments: { text: "leak" } });
    const text = textOf(result);
    expect(text).not.toContain("sk-ant-api03");
    expect(text).toContain("[REDACTED:");
    expect(text).toContain("and that is all");
  });

  it("answers an unknown tool with a protocol error, not a tool result", async () => {
    const { client } = await open([]);
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(/no_such_tool/);
  });
});
