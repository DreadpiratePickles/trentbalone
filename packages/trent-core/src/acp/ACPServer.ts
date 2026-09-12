import http from "node:http";
import fs from "node:fs";
import { FleetManager } from "../fleet/FleetManager.js";
import { ConfigManager } from "../config/ConfigManager.js";

export interface ACPServerOptions {
  port?: number;
  configManager?: ConfigManager;
}

export class ACPServer {
  private port: number;
  private server: http.Server | null = null;
  private running = false;
  private fleetManager: FleetManager;

  constructor(options?: ACPServerOptions) {
    this.port = options?.port || 7890;
    const cfg = options?.configManager || new ConfigManager();
    this.fleetManager = new FleetManager(cfg);
  }

  public isRunning(): boolean {
    return this.running;
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
        return {
          jsonrpc: "2.0",
          id,
          result: {
            agent: params?.agent || "engineer",
            response: `[ACP Editor Dispatch]: Processing task "${params?.prompt || "inspect"}" in editor workspace.`,
          },
        };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method "${method}" not found` },
        };
    }
  }
}
