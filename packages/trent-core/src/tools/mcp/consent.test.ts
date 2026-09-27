/**
 * [T-08] Consent before spawn for stdio MCP servers, exercised over the real protocol against the
 * fake stdio server. A server with no recorded consent must never be spawned; a consented one must
 * connect; and a consented server whose tool definitions later differ from the pinned hash must be
 * refused (rug-pull defense).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../../config/schema.js";
import { resolveMcpArtifact, type McpArtifactPin } from "./artifact.js";
import { connectMcpServer, type McpConnection, type StdioTransportFactory } from "./client.js";
import { fileConsentGate, grantMcpConsent, mcpConsentAll, mcpConsentPath, mcpToolDefHash, readMcpConsent, type McpConsentGate } from "./consent.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-mcp-server.mjs");
const HOST_ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };

let root = "";
const open: McpConnection[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-consent-"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

function server(extraArgs: string[] = []): Extract<McpServerConfig, { transport: "stdio" }> {
  return { transport: "stdio", command: process.execPath, args: [FIXTURE, ...extraArgs], env: {}, auto_approve: [], enabled: true };
}

/** [D13] What `trent mcp add` pins alongside the launch spec: the script the server runs. */
function artifact(): McpArtifactPin {
  const resolved = resolveMcpArtifact(server(), { cwd: process.cwd(), env: HOST_ENV });
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.pin;
}

describe("[T-08] consent before spawn", () => {
  it("refuses to spawn a stdio server with no recorded consent, and never invokes the spawn seam", async () => {
    const spawns: unknown[] = [];
    const spy: StdioTransportFactory = (params) => {
      spawns.push(params);
      throw new Error("the spawn seam must not be reached when consent is missing");
    };
    await expect(connectMcpServer("fake", server(), { env: HOST_ENV, stdioTransport: spy })).rejects.toThrow(/consent/i);
    expect(spawns).toEqual([]);
  });

  it("connects when the exact launch spec is consented", async () => {
    const c = await connectMcpServer("fake", server(), { env: HOST_ENV, consent: mcpConsentAll() });
    open.push(c);
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "env-names"]));
  });

  it("reads consent from a profile's 0600 record: an unconsented spec is refused, the granted one connects", async () => {
    const profileDir = fs.mkdtempSync(path.join(root, "profile-"));
    const spy = { count: 0 };
    const spawnSpy: StdioTransportFactory = () => {
      spy.count++;
      throw new Error("unreachable");
    };
    // Nothing recorded yet: refused before spawn.
    await expect(connectMcpServer("fake", server(), { env: HOST_ENV, profileDir, stdioTransport: spawnSpy })).rejects.toThrow(/consent/i);
    expect(spy.count).toBe(0);
    // The operator records consent; the file is 0600 and now the same connect proceeds.
    grantMcpConsent(profileDir, "fake", server(), undefined, artifact());
    expect(fs.statSync(mcpConsentPath(profileDir)).mode & 0o777).toBe(0o600);
    expect(readMcpConsent(profileDir).consented).toHaveLength(1);
    const c = await connectMcpServer("fake", server(), { env: HOST_ENV, profileDir });
    open.push(c);
    expect((await c.listTools()).map((t) => t.name)).toContain("echo");
  });

  it("refuses a consented server whose tool definitions changed since the pinned hash (rug pull)", async () => {
    const gate: McpConsentGate = { status: () => ({ consented: true, artifact: artifact(), toolsHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }) };
    await expect(connectMcpServer("fake", server(), { env: HOST_ENV, consent: gate })).rejects.toThrow(/tool definitions changed|rug pull/i);
  });

  it("accepts a consented server whose tool-def hash still matches what was pinned", async () => {
    // Pin the real hash first (as `trent mcp add` would after listing the tools).
    const probe = await connectMcpServer("fake", server(), { env: HOST_ENV, consent: mcpConsentAll() });
    const toolsHash = mcpToolDefHash(await probe.listTools());
    await probe.close();
    const profileDir = fs.mkdtempSync(path.join(root, "pinned-"));
    grantMcpConsent(profileDir, "fake", server(), toolsHash, artifact());
    const gate = fileConsentGate(profileDir);
    expect(gate.status("fake", server())).toEqual({ consented: true, toolsHash, artifact: artifact() });
    const c = await connectMcpServer("fake", server(), { env: HOST_ENV, consent: gate });
    open.push(c);
    expect((await c.listTools()).length).toBeGreaterThan(0);
  });
});
