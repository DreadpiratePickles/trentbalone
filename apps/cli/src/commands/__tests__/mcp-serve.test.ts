/**
 * U5 / G9 — `trent mcp serve`: the profile's toolsets as an MCP server on the headless runtime
 * every other surface runs on, charged to `surface: "mcp"`. Driven through `runCli` with a fake
 * runtime (no proxy, sandbox or model); the HTTP side is proved with the SDK's own client, the
 * bearer rule with a non-loopback bind that must refuse before any runtime is built.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@trent/core/errors/index.js";
import { record as toRecord } from "@trent/core/tools/action.js";
import type { TrentToolAdapter } from "@trent/core/tools/types.js";
import { renderToolInstructions } from "@trent/core/tools/web/schemas.js";
import { runCli } from "../index.js";
import type { CliOverrides } from "../context.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";

let home: string;
const clients: Client[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-mcp-serve-"));
  process.env.TRENT_HOME = home;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  delete process.env.TRENT_HOME;
  delete process.env.MY_MCP_TOKEN;
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeSignals(order: string[]) {
  const listeners = new Map<string, Array<() => void>>();
  return {
    once(event: string, listener: () => void): unknown {
      const forEvent = listeners.get(event) ?? [];
      forEvent.push(listener);
      listeners.set(event, forEvent);
      return undefined;
    },
    exit(code: number): void {
      order.push(`exit:${code}`);
    },
    async raise(event: string): Promise<void> {
      for (const listener of listeners.get(event) ?? []) listener();
      for (let i = 0; i < 200 && !order.some((entry) => entry.startsWith("exit:")); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
  };
}

function adapter(name: string, tool: string): TrentToolAdapter {
  return {
    name,
    scopes: [name, tool],
    availability: "real",
    instructions: renderToolInstructions([{ name: tool, description: `Fake ${tool}.`, parameters: { type: "object", properties: { q: { type: "string" } } } }]),
    routingText: tool,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => toRecord(name, action, "completed", `${tool} answered`),
    cleanup: async () => undefined,
  };
}

function fakes() {
  const order: string[] = [];
  const runtimeDeps: HeadlessRuntimeDeps[] = [];
  const cleanup = vi.fn(async () => {
    order.push("cleanup");
    return undefined;
  });
  const runtime = {
    orchestrator: {},
    companyId: "cmp_mcp",
    tools: { adapters: [adapter("web", "web_search")], hookNotices: [] },
    fleetMemory: { adapters: [adapter("memory", "memory"), adapter("brain_read", "brain_read")] },
    run: () => {
      throw new Error("mcp serve never starts a run of its own");
    },
    cleanup,
  } as unknown as HeadlessRuntime;
  const signals = fakeSignals(order);
  const overrides: CliOverrides = {
    signals,
    gatewayRuntime: async (deps) => {
      runtimeDeps.push(deps);
      return runtime;
    },
  };
  return { order, runtimeDeps, cleanup, signals, overrides };
}

async function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "cli-host", version: "0.0.1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

describe("trent mcp serve", () => {
  it("--dry-run reports the transport and port and builds no runtime", async () => {
    const f = fakes();
    const stdio = await runCli(["mcp", "serve", "--json", "--dry-run"], { overrides: f.overrides });
    expect(stdio.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(stdio.stdout)).toMatchObject({ dryRun: true, command: "mcp serve", transport: "stdio" });
    const http = await runCli(["mcp", "serve", "--json", "--dry-run", "--http", "--port", "7901"], { overrides: f.overrides });
    expect(JSON.parse(http.stdout)).toMatchObject({ dryRun: true, transport: "http", port: 7901, host: "127.0.0.1", authenticated: false });
    expect(f.runtimeDeps).toEqual([]);
  });

  it("--http binds loopback on the mcp surface, lists the toolsets and the brain tools to an MCP client, and Ctrl+C releases the runtime", async () => {
    const f = fakes();
    const result = await runCli(["mcp", "serve", "--json", "--http", "--port", "7931"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.keepAlive).toBe(true);
    const data = JSON.parse(result.stdout) as { port: number; host: string; transport: string; authenticated: boolean; tools: string[]; listening: boolean };
    expect(data).toMatchObject({ transport: "http", host: "127.0.0.1", authenticated: false, listening: true });
    expect(data.tools).toEqual(["web_search", "memory", "brain_read"]);
    expect(f.runtimeDeps).toHaveLength(1);
    expect(f.runtimeDeps[0]!.surface).toBe("mcp");

    const client = await connect(`http://127.0.0.1:${String(data.port)}/mcp`);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "memory", "brain_read"]);
    const answered = await client.callTool({ name: "brain_read", arguments: { q: "what do we know" } });
    expect(answered.structuredContent).toMatchObject({ status: "completed", surface: "mcp" });

    await f.signals.raise("SIGINT");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["cleanup", `exit:${EXIT.INTERRUPT}`]);
  });

  it("--http on a non-loopback host refuses to start without a token, before any runtime is built", async () => {
    const f = fakes();
    const result = await runCli(["mcp", "serve", "--json", "--http", "--host", "0.0.0.0", "--port", "7932"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(`${result.stdout}${result.stderr}`).toContain("TRENT_MCP_TOKEN");
    expect(f.runtimeDeps).toEqual([]);
  });

  it("--token-env names the variable holding the bearer; the value is required by the server and never printed", async () => {
    const f = fakes();
    process.env.MY_MCP_TOKEN = "cli-bearer-value-0123456789";
    const result = await runCli(["mcp", "serve", "--json", "--http", "--port", "7933", "--token-env", "MY_MCP_TOKEN"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).not.toContain("cli-bearer-value");
    const data = JSON.parse(result.stdout) as { port: number; authenticated: boolean };
    expect(data.authenticated).toBe(true);
    await expect(connect(`http://127.0.0.1:${String(data.port)}/mcp`)).rejects.toThrow(/bearer token/);
    const client = await connect(`http://127.0.0.1:${String(data.port)}/mcp`, { Authorization: "Bearer cli-bearer-value-0123456789" });
    expect((await client.listTools()).tools).toHaveLength(3);
    await f.signals.raise("SIGINT");
  });

  it("--token-env naming an unset variable is a config error that names the variable", async () => {
    const f = fakes();
    const result = await runCli(["mcp", "serve", "--json", "--http", "--port", "7934", "--token-env", "MY_MCP_TOKEN"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(`${result.stdout}${result.stderr}`).toContain("MY_MCP_TOKEN");
    expect(f.runtimeDeps).toEqual([]);
  });
});
