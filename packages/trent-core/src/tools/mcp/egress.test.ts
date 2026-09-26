/**
 * P2-14 RED — an http MCP server through the REAL egress proxy, with a broker token that carries a
 * credential, which is what the REPL's token carries (the model provider key).
 *
 * Without the own-credential marker the proxy deletes the configured `Authorization` header and
 * writes `Bearer <credential>` in its place (`CredentialBroker.ts` applyCredentials), so the MCP
 * server would receive the model key instead of the token its entry names. These prove every
 * request of a real Streamable HTTP session (initialize, the initialized notification, the
 * optional SSE GET, tools/list, tools/call) carries the server's own header exactly once, and a
 * server configured with no header receives none.
 *
 * The server is a minimal JSON-response Streamable HTTP endpoint on 127.0.0.1 that records every
 * request's headers; the proxy dials it through `upstreamOverrides` under a public-looking name,
 * and `lookup` answers that name with a TEST-NET address so the SSRF floor passes without DNS.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServersConfig } from "../../config/schema.js";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { createMcpAdapters, type McpAdapterBuild } from "./index.js";

const MODEL_KEY = "model-key-fixture-must-never-reach-an-mcp-server";
const MCP_TOKEN = "mcp-own-bearer-fixture";
const HOST = "mcp.fake-server.test";

interface Recorded {
  readonly method: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly rpc?: string;
}

/** JSON-RPC over POST, answered as `application/json`; GET is 405 (no SSE stream), as the spec allows. */
class FakeHttpMcp {
  readonly requests: Recorded[] = [];
  private server: http.Server | undefined;
  port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const method = (req.method ?? "GET").toUpperCase();
        if (method !== "POST") {
          this.requests.push({ method, headers: req.headers });
          res.writeHead(405).end();
          return;
        }
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number | string; method: string; params?: Record<string, unknown> };
        this.requests.push({ method, headers: req.headers, rpc: message.method });
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: this.answer(message.method, message.params ?? {}) }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    if (method === "initialize") return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-http", version: "1.0.0" } };
    if (method === "tools/list") return { tools: [{ name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    if (method === "tools/call") return { content: [{ type: "text", text: `echo: ${String((params.arguments as { text?: unknown } | undefined)?.text ?? "")}` }] };
    return {};
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let root: string;
let proxy: EgressProxy;
let brokerToken: string;
let fake: FakeHttpMcp;
const builds: McpAdapterBuild[] = [];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-egress-"));
  fake = new FakeHttpMcp();
  await fake.start();
  const tokens = new TokenManager({ ephemeral: true });
  proxy = new EgressProxy({
    port: 0,
    ca: new CertificateAuthority({ dir: path.join(root, "ca") }),
    tokenManager: tokens,
    interceptDomains: [HOST],
    upstreamOverrides: { [HOST]: { host: "127.0.0.1", port: fake.port } },
  });
  await proxy.start();
  brokerToken = tokens.issueToken("trent-repl", { apiKey: MODEL_KEY }, "repl");
});

afterEach(async () => {
  for (const build of builds.splice(0)) for (const adapter of build.adapters) await adapter.cleanup();
  await fake.stop();
  await proxy.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

async function build(headers: Record<string, string>): Promise<McpAdapterBuild> {
  const servers: McpServersConfig = { fake: { transport: "http", url: `http://${HOST}/mcp`, headers, auto_approve: ["echo"], enabled: true } };
  const built = await createMcpAdapters(
    { mcp_servers: servers },
    {
      profileDir: path.join(root, "profile"),
      env: { MCP_TOKEN },
      egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token: brokerToken },
      lookup: async () => [{ address: "203.0.113.7", family: 4 }],
      redactionLog: () => undefined,
    },
  );
  builds.push(built);
  return built;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("an http MCP server through the egress proxy", () => {
  it("receives its own configured bearer on every request, exactly once, and never the broker's credential or token", async () => {
    const { adapters, unavailable } = await build({ Authorization: "Bearer ${MCP_TOKEN}" });
    expect(unavailable).toEqual([]);
    const result = await adapters[0]!.execute('mcp_fake_echo {"text":"hi"}', {});
    expect(result.status, result.summary).toBe("completed");
    expect(result.summary).toBe("echo: hi");
    expect(fake.requests.map((request) => request.rpc).filter(Boolean)).toEqual(expect.arrayContaining(["initialize", "notifications/initialized", "tools/list", "tools/call"]));
    for (const request of fake.requests) {
      const label = `${request.method} ${request.rpc ?? ""}`;
      expect(request.headers.authorization, label).toBe(`Bearer ${MCP_TOKEN}`);
      const all = JSON.stringify(request.headers);
      expect(occurrences(all, MCP_TOKEN), label).toBe(1);
      expect(all, label).not.toContain(MODEL_KEY);
      expect(all, label).not.toContain(brokerToken);
      expect(request.headers["x-trent-own-credential"], label).toBeUndefined();
    }
  });

  it("a server configured with no header receives no Authorization at all", async () => {
    const { adapters, unavailable } = await build({});
    expect(unavailable).toEqual([]);
    expect((await adapters[0]!.execute('mcp_fake_echo {"text":"hi"}', {})).status).toBe("completed");
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.headers.authorization, request.rpc).toBeUndefined();
      expect(JSON.stringify(request.headers), request.rpc).not.toContain(MODEL_KEY);
    }
  });
});
