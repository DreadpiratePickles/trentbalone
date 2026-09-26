/**
 * [C16] How Hermes gets Trent's tools: Trent's own MCP server, the code `trent mcp serve --http` runs
 * (`createTrentMcpServer` behind `createMcpHttpServer`), bound on loopback in the bench's process and serving
 * the bench's tool build. `trent mcp serve` itself serves the profile's REAL providers, which a bench must never
 * reach; this is the same server over the fakes. Every call from Hermes is dispatched exactly as a host's call
 * is (`mcp-server/server.ts`: a deferred tool through the bridge's `tool_call`), and meets the same owner at
 * the same seam as a Trent run's call.
 *
 * Each Hermes process opens its own MCP session, so each attempt's calls carry their own run id.
 */
import { createMcpHttpServer, MCP_HTTP_PATH } from "../mcp-server/transport.js";
import { createTrentMcpServer } from "../mcp-server/server.js";
import type { TrentToolAdapter } from "../tools/types.js";

export interface BenchToolHost {
  /** `http://127.0.0.1:<port>/mcp`: what HERMES_HOME's `mcp_servers.trent.url` names. */
  readonly url: string;
  close(): Promise<void>;
}

export async function hostBenchTools(input: { readonly adapters: readonly TrentToolAdapter[]; readonly profileDir: string }): Promise<BenchToolHost> {
  const http = createMcpHttpServer({
    host: "127.0.0.1",
    port: 0,
    createServer: () => createTrentMcpServer({ adapters: input.adapters, profileDir: input.profileDir, companyId: "bench", version: "bench", log: () => undefined }),
  });
  await http.start();
  return { url: `http://127.0.0.1:${String(http.port)}${MCP_HTTP_PATH}`, close: () => http.stop() };
}
