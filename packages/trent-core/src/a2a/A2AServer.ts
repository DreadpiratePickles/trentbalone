import http from "node:http";
import { generateAgentCard, type AgentCard } from "./AgentCard.js";

export interface A2AServerOptions {
  port?: number;
  secret?: string;
  baseUrl?: string;
}

export interface A2ATaskPayload {
  taskId: string;
  originAgent: string;
  targetAgent: string;
  taskType: string;
  parameters: Record<string, unknown>;
}

export class A2AServer {
  private port: number;
  private secret: string;
  private baseUrl: string;
  private server: http.Server | null = null;
  private running = false;

  constructor(options?: A2AServerOptions) {
    this.port = options?.port || 7895;
    this.secret = options?.secret || "trent-a2a-default-secret";
    this.baseUrl = options?.baseUrl || `http://127.0.0.1:${this.port}`;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getPort(): number {
    return this.port;
  }

  public async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-A2A-Origin");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. GET /a2a/card/:agentId
        if (req.method === "GET" && url.pathname.startsWith("/a2a/card/")) {
          const agentId = url.pathname.replace("/a2a/card/", "").trim() || "ceo";
          const card = generateAgentCard(
            {
              id: agentId,
              name: `Trent ${agentId.toUpperCase()} Agent`,
              description: `Autonomous cofounder specialist in ${agentId}.`,
              category: "specialist",
              capabilities: ["task-execution", "analysis", "synthesis"],
              endpoint: `${this.baseUrl}/a2a/tasks`,
            },
            this.secret
          );

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(card, null, 2));
          return;
        }

        // 2. POST /a2a/tasks
        if (req.method === "POST" && url.pathname === "/a2a/tasks") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              const payload = JSON.parse(body) as A2ATaskPayload;
              const result = {
                taskId: payload.taskId,
                status: "completed",
                result: {
                  agent: payload.targetAgent,
                  taskType: payload.taskType,
                  summary: `A2A delegation for task ${payload.taskId} resolved successfully.`,
                  completedAt: new Date().toISOString(),
                },
              };
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (err: any) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `Invalid task JSON: ${err.message}` }));
            }
          });
          return;
        }

        // Health/root
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ a2a: "trent-fleet", status: "online" }));
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
}
