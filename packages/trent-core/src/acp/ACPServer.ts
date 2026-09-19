/**
 * The ACP server behind `trent acp`, for VS Code, Cursor and Zed: a THIN adapter over `chat.ts`.
 *
 * `agent/chat` used to answer every editor request with a template string built from the prompt —
 * no model, no orchestrator, the defect AGENTS.md invariant 2 exists to prevent. The behaviour now
 * lives in `runAgentChat`, which has no transport in it; this file only routes a request to it and
 * puts the outcome into a JSON-RPC envelope. The handshake (`initialize`), `fleet/status` and
 * `file/read` are unchanged.
 *
 * THIS IS NOT THE PROTOCOL. The Agent Client Protocol is stdio JSON-RPC, and Trent speaks it in
 * `./stdio.ts`, which is what `trent acp` runs. This server speaks JSON-RPC over HTTP on port 7890
 * and survives as `trent acp --http` for the integrations and tests that already use it. Nothing
 * here is hardened; keep new behaviour in `chat.ts` or `stdio.ts`.
 */

import http from "node:http";
import fs from "node:fs";
import { FleetManager } from "../fleet/FleetManager.js";
import { ConfigManager } from "../config/ConfigManager.js";
import type { AgentRunner } from "../agent-runner/index.js";
import { runAgentChat, type ACPChatParams } from "./chat.js";

export interface ACPServerOptions {
  port?: number;
  configManager?: ConfigManager;
  /** The agent runtime `agent/chat` runs on. Absent, `agent/chat` refuses. */
  runner?: AgentRunner;
}

export class ACPServer {
  private port: number;
  private server: http.Server | null = null;
  private running = false;
  private fleetManager: FleetManager;
  private runner: AgentRunner | undefined;
  private inFlight = new Set<AbortController>();

  constructor(options?: ACPServerOptions) {
    this.port = options?.port || 7890;
    const cfg = options?.configManager || new ConfigManager();
    this.fleetManager = new FleetManager(cfg);
    this.runner = options?.runner;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** True when `agent/chat` will reach a real agent runtime. */
  public hasRunner(): boolean {
    return this.runner !== undefined;
  }

  public getPort(): number {
    return this.port;
  }

  public async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/acp") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });

          req.on("end", async () => {
            try {
              const rpc = JSON.parse(body);
              const response = await this.handleRpc(rpc);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(response));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: err.message } }));
            }
          });
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ acp: "trent-fleet", status: "online", port: this.port }));
        }
      });

      this.server.on("error", (err) => {
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.running = true;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.running || !this.server) return;
    // No orchestration outlives the server that started it.
    for (const controller of this.inFlight) controller.abort();

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRpc(rpc: { jsonrpc: string; id: any; method: string; params?: any }): Promise<any> {
    const { id, method, params } = rpc;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            serverInfo: { name: "trent-acp-server", version: "1.0.0" },
            capabilities: {
              fileOperations: true,
              agentDispatch: true,
              fleetCoordination: true,
            },
          },
        };

      case "fleet/status":
        return {
          jsonrpc: "2.0",
          id,
          result: this.fleetManager.getStatus(),
        };

      case "file/read":
        if (!params?.path || !fs.existsSync(params.path)) {
          return { jsonrpc: "2.0", id, error: { code: -32602, message: "File not found" } };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: { content: fs.readFileSync(params.path, "utf8") },
        };

      case "agent/chat":
        return await this.handleChat(id, params);

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method "${method}" not found` },
        };
    }
  }

  /** Routes the request to `runAgentChat` and envelopes whatever comes back. Nothing else. */
  private async handleChat(id: unknown, params: ACPChatParams | undefined): Promise<unknown> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const outcome = await runAgentChat(this.runner, params, controller.signal);
      if (!outcome.ok) return { jsonrpc: "2.0", id, error: outcome.error };
      return { jsonrpc: "2.0", id, result: outcome.result };
    } finally {
      this.inFlight.delete(controller);
    }
  }
}
