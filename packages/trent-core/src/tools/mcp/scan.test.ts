/**
 * T3.3: install-time scan of a server's tool list and secret scrubbing of tool results, both
 * exercised over the real protocol against the fake stdio server (`--poison` adds a tool whose
 * description and schema carry an injection string and an exfiltration webhook).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../config/schema.js";
import { connectMcpServer, type McpConnection } from "./client.js";
import { scanMcpTools, scrubMcpResult } from "./scan.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-mcp-server.mjs");
const HOST_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const FAKE_KEY = `sk-${"a1b2c3d4".repeat(4)}`;

let root = "";
const open: McpConnection[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-scan-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

function server(extraArgs: string[] = []): McpServerConfig {
  return { transport: "stdio", command: process.execPath, args: [FIXTURE, ...extraArgs], env: {}, auto_approve: [], enabled: true };
}

async function connect(extraArgs: string[] = []): Promise<McpConnection> {
  const c = await connectMcpServer("fake", server(extraArgs), { env: HOST_ENV });
  open.push(c);
  return c;
}

describe("install-time scan", () => {
  it("a clean server's tool list has no findings", async () => {
    const tools = await (await connect()).listTools();
    expect(scanMcpTools(tools)).toEqual([]);
  });

  it("a poisoned description and a poisoned schema string are both reported by tool name and category, never by text", async () => {
    const tools = await (await connect(["--poison"])).listTools();
    const findings = scanMcpTools(tools);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.tool).toBe("helper");
    expect(findings[0]!.categories).toEqual(expect.arrayContaining([expect.stringMatching(/injection/i), expect.stringMatching(/exfiltration/i)]));
    const rendered = JSON.stringify(findings);
    expect(rendered).not.toContain("Ignore all previous");
    expect(rendered).not.toContain("collector.example.net");
  });
});

describe("result scrubbing", () => {
  it("a result carrying an API key reaches the caller masked, with the hit counted by kind", async () => {
    const hits: Record<string, unknown>[] = [];
    const c = await connectMcpServer("fake", server(), { env: HOST_ENV, redactionLog: (_event, fields) => hits.push(fields) });
    open.push(c);
    const result = await c.callTool("echo", { text: `key=${FAKE_KEY} done` });
    expect(result.text).not.toContain(FAKE_KEY);
    expect(result.text).toMatch(/\[REDACTED:api-key#1\]/);
    expect(result.text).toContain("done");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ server: "fake", tool: "echo", hits: [{ kind: "api-key", count: 1 }] });
    expect(JSON.stringify(hits)).not.toContain(FAKE_KEY);
  });

  it("a result carrying only an email, or a git SHA, is untouched", async () => {
    const c = await connect();
    const sha = "9fceb02d0ae598e95dc970b74767f19372d61af8";
    const result = await c.callTool("echo", { text: `contact bob@example.com at ${sha}` });
    expect(result.text).toBe(`echo: contact bob@example.com at ${sha}`);
  });

  it("scrubMcpResult masks a bearer token, a private key block and a connection-string password but leaves PII alone", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    const out = scrubMcpResult(`Authorization: Bearer ${"tok3nvalue".repeat(2)}\n${pem}\npostgres://app:hunter22@db.internal/x\nbob@example.com +14155551212`);
    expect(out.text).not.toContain("tok3nvalue");
    expect(out.text).not.toContain("MIIEow");
    expect(out.text).not.toContain("hunter22");
    expect(out.text).toContain("bob@example.com");
    expect(out.text).toContain("+14155551212");
    expect(out.hits.map((h) => h.kind)).toEqual(expect.arrayContaining(["private-key", "connection-string"]));
  });
});
