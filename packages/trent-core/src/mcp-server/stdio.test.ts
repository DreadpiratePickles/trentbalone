/**
 * U5 / G9 — the stdio proof: a real child process (`__fixtures__/serve-fake.ts`), the SDK's own
 * stdio client, real pipes. Tools list matches the enabled toolsets; a call reaches the fake
 * adapter; a hardline command is refused; a gated call parks an approval the founder settles in
 * `gateway.json`, after which the same call runs.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalBridge, FileGatewayStore } from "../gateway/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "serve-fake.ts");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let home: string;
let workspace: string;
let profileDir: string;
let client: Client | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-stdio-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-stdio-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", FIXTURE, profileDir, workspace, home],
    cwd: REPO_ROOT,
    env: { ...process.env, TRENT_QUEUE_FALLBACK: "disabled" } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "stdio-host", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

function textOf(result: unknown): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? raw : [];
  return content.map((item) => (typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "")).join("\n");
}

describe("trent mcp serve --stdio, over real pipes", () => {
  it("lists the enabled toolsets' tools, runs a call, refuses a hardline command, and parks then runs a gated call", async () => {
    const host = await connect();
    const { tools } = await host.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["read_file", "write_file", "patch", "search_files", "terminal", "process_manage", "brain_echo"]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
    expect(names).not.toContain("tool_call");

    const echoed = await host.callTool({ name: "brain_echo", arguments: { text: "over stdio" } });
    expect(textOf(echoed)).toBe("echo: over stdio");

    const refused = await host.callTool({ name: "terminal", arguments: { command: "rm -rf ~" } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("recursive-delete-of-root-home-or-profile");

    const args = { path: "stdio.txt", content: "approved over stdio" };
    const parked = await host.callTool({ name: "write_file", arguments: args });
    const structured = parked.structuredContent as { status: string; approval_id: string };
    expect(structured.status).toBe("needs_approval");
    const bridge = new ApprovalBridge({ store: new FileGatewayStore(path.join(profileDir, "gateway.json")) });
    expect(bridge.getApproval(structured.approval_id)?.agentId).toBe("mcp:stdio-host");
    bridge.decide(structured.approval_id, "approved", "human");
    const done = await host.callTool({ name: "write_file", arguments: args });
    expect(done.structuredContent).toMatchObject({ status: "completed" });
    expect(fs.readFileSync(path.join(workspace, "stdio.txt"), "utf8")).toBe("approved over stdio");
  }, 60_000);
});
