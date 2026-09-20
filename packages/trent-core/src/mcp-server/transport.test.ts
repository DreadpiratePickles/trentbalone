/**
 * U5 / G9 — the Streamable HTTP side of `trent mcp serve`: loopback by default, a bearer token
 * required before a non-loopback bind is even attempted (the A2A card's rule, `a2a/card.ts`),
 * `Origin` validated as the transport specification demands, and one Trent server (one run
 * scope) per MCP session. Driven with the SDK's own HTTP client.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TrentError } from "../errors/index.js";
import { record as toRecord } from "../tools/action.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { renderToolInstructions } from "../tools/web/schemas.js";
import { createTrentMcpServer, type TrentMcpServer } from "./server.js";
import { createMcpHttpServer, isLoopbackHost, MCP_HTTP_PATH, type McpHttpServer } from "./transport.js";

let profileDir: string;
let http: McpHttpServer | undefined;
const clients: Client[] = [];

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-http-"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await http?.stop();
  http = undefined;
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function fake(): TrentToolAdapter {
  return {
    name: "brain_read",
    scopes: ["brain_read", "ping"],
    availability: "real",
    instructions: renderToolInstructions([{ name: "ping", description: "Answer with the run id.", parameters: { type: "object", properties: {} } }]),
    routingText: "ping",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => toRecord("brain_read", action, "completed", "pong"),
    cleanup: async () => undefined,
  };
}

function factory(created: TrentMcpServer[]) {
  return (): TrentMcpServer => {
    const server = createTrentMcpServer({ adapters: [fake()], profileDir });
    created.push(server);
    return server;
  };
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "http-host", version: "0.0.1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

describe("isLoopbackHost", () => {
  it("knows the loopback names and addresses and nothing else", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2"]) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", ""]) expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe("createMcpHttpServer", () => {
  it("refuses to bind a non-loopback host without a bearer token, before any socket exists", async () => {
    const created: TrentMcpServer[] = [];
    http = createMcpHttpServer({ host: "0.0.0.0", port: 0, createServer: factory(created) });
    await expect(http.start()).rejects.toBeInstanceOf(TrentError);
    await expect(http.start()).rejects.toThrow(/token/);
    expect(http.listening).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("serves loopback with a token: the right bearer lists tools, a missing one is 401, a foreign Origin is 403, and each session is its own run", async () => {
    const created: TrentMcpServer[] = [];
    http = createMcpHttpServer({ host: "127.0.0.1", port: 0, token: "test-bearer-token-value", createServer: factory(created) });
    await http.start();
    expect(http.listening).toBe(true);
    expect(http.authenticated).toBe(true);
    const url = `http://127.0.0.1:${String(http.port)}${MCP_HTTP_PATH}`;

    const one = await connect(url, { Authorization: "Bearer test-bearer-token-value" });
    const { tools } = await one.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
    const pong = await one.callTool({ name: "ping", arguments: {} });
    expect(pong.structuredContent).toMatchObject({ status: "completed", surface: "mcp" });

    const two = await connect(url, { Authorization: "Bearer test-bearer-token-value" });
    await two.listTools();
    expect(created).toHaveLength(2);
    expect(created[0]!.runId).not.toBe(created[1]!.runId);

    // The SDK client surfaces the refusal body, not the status line; the body names the rule.
    await expect(connect(url)).rejects.toThrow(/requires the bearer token/);
    await expect(connect(url, { Authorization: "Bearer wrong-value" })).rejects.toThrow(/requires the bearer token/);
    await expect(connect(url, { Authorization: "Bearer test-bearer-token-value", Origin: "https://evil.example.net" })).rejects.toThrow(/Origin header/);
    expect(created).toHaveLength(2);
    // The value never appears in what the server says about itself.
    expect(JSON.stringify(http.describe())).not.toContain("test-bearer-token-value");
  });

  it("serves loopback without a token, and says so", async () => {
    const created: TrentMcpServer[] = [];
    http = createMcpHttpServer({ host: "127.0.0.1", port: 0, createServer: factory(created) });
    await http.start();
    expect(http.authenticated).toBe(false);
    const client = await connect(`http://127.0.0.1:${String(http.port)}${MCP_HTTP_PATH}`);
    expect((await client.listTools()).tools).toHaveLength(1);
    expect(http.describe()).toMatchObject({ transport: "http", host: "127.0.0.1", authenticated: false });
  });
});
