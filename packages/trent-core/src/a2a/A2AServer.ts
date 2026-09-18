/**
 * The A2A (Agent-to-Agent) protocol server: a THIN HTTP adapter over `A2ATaskEngine`.
 *
 * `POST /a2a/tasks` used to answer every delegation with `status: "completed"` and a sentence it
 * composed itself, with no model and no orchestrator behind it — exactly what AGENTS.md invariant
 * 2 forbids, and the old test asserted the literal rather than the behaviour.
 *
 * All of the behaviour now lives in `TaskLifecycle.ts`, which has no transport in it. This file
 * only parses a request, hands it over, and maps the outcome onto status codes: a refusal (no
 * runtime attached) becomes HTTP 503 with a plain reason, and a task becomes 200 with its record.
 *
 * WIRE SHAPE IS PROVISIONAL. The payload below is Trent's own, not the A2A specification's
 * `Task` / `Message` / `Part` / `Artifact` schema, and is expected to be replaced for Hermes
 * interop. Nothing here is hardened for that reason; keep new behaviour in the engine.
 */

import http from "node:http";
import { generateAgentCard } from "./AgentCard.js";
import { A2ATaskEngine, type A2ATask, type A2ATaskRequest } from "./TaskLifecycle.js";
import type { AgentRunner } from "../agent-runner/index.js";

export interface A2AServerOptions {
  port?: number;
  secret?: string;
  baseUrl?: string;
  /** The agent runtime a delegated task runs on. Absent, the task endpoint refuses with 503. */
  runner?: AgentRunner;
}

/** Trent's provisional task payload. Not the A2A specification's message schema. */
export interface A2ATaskPayload {
  taskId: string;
  originAgent: string;
  targetAgent: string;
  taskType: string;
  parameters: Record<string, unknown>;
  /** The delegating agent's own words. Preferred over the objective composed from the fields above. */
  objective?: string;
}

/**
 * The objective a delegated task runs. An explicit `objective` is the delegating agent's own text
 * and wins; otherwise it is assembled from the fields the caller sent. Nothing here is an answer —
 * it is the QUESTION, built from the caller's input, exactly as the gateway uses a chat message.
 */
export function a2aObjective(payload: A2ATaskPayload): string {
  const explicit = typeof payload.objective === "string" ? payload.objective.trim() : "";
  if (explicit !== "") return explicit;
  const parameters =
    payload.parameters !== undefined && payload.parameters !== null && Object.keys(payload.parameters).length > 0
      ? `\nParameters: ${JSON.stringify(payload.parameters)}`
      : "";
  return `${payload.taskType} for the ${payload.targetAgent} seat, delegated by ${payload.originAgent}.${parameters}`;
}

/** The provisional payload, read into the transport-independent request the engine takes. */
export function a2aRequestFrom(payload: A2ATaskPayload): A2ATaskRequest {
  return {
    id: String(payload.taskId ?? ""),
    agent: String(payload.targetAgent ?? ""),
    taskType: String(payload.taskType ?? ""),
    objective: a2aObjective(payload),
  };
}

export class A2AServer {
  private port: number;
  private secret: string;
  private baseUrl: string;
  private server: http.Server | null = null;
  private running = false;
  private engine: A2ATaskEngine;
  private inFlight = new Set<AbortController>();

  constructor(options?: A2AServerOptions) {
    this.port = options?.port || 7895;
    this.secret = options?.secret || "trent-a2a-default-secret";
    this.baseUrl = options?.baseUrl || `http://127.0.0.1:${this.port}`;
    this.engine = new A2ATaskEngine(options?.runner === undefined ? {} : { runner: options.runner });
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getPort(): number {
    return this.port;
  }

  /** True when a task submitted here will reach a real agent runtime. */
  public hasRunner(): boolean {
    return this.engine.hasRunner();
  }

  /** The stored record for a task id, or undefined. The same object `GET /a2a/tasks/:id` serves. */
  public getTask(id: string): A2ATask | undefined {
    return this.engine.get(id);
  }

  public async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.running = true;
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.running || !this.server) return;
    // Every run still draining is told to stop before the socket goes, so no orchestration
    // outlives the server that started it.
    for (const controller of this.inFlight) controller.abort();

    return new Promise((resolve) => {
      this.server?.close(() => {
        this.running = false;
        this.server = null;
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-A2A-Origin");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

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
        this.secret,
      );
      send(res, 200, card);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/a2a/tasks/")) {
      const id = decodeURIComponent(url.pathname.replace("/a2a/tasks/", "").trim());
      const task = this.engine.get(id);
      if (task === undefined) {
        send(res, 404, { error: `no task with id "${id}" was submitted to this server` });
        return;
      }
      send(res, 200, task);
      return;
    }

    if (req.method === "POST" && url.pathname === "/a2a/tasks") {
      await this.handleTask(req, res);
      return;
    }

    send(res, 200, { a2a: "trent-fleet", status: "online", runner: this.hasRunner() });
  }

  private async handleTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let payload: A2ATaskPayload;
    try {
      payload = JSON.parse(await readBody(req)) as A2ATaskPayload;
    } catch (err) {
      send(res, 400, { error: `Invalid task JSON: ${(err as Error).message}` });
      return;
    }

    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const outcome = await this.engine.submit(a2aRequestFrom(payload), controller.signal);
      if (!outcome.ok) {
        send(res, 503, { taskId: payload.taskId, error: outcome.reason });
        return;
      }
      send(res, 200, outcome.task);
    } finally {
      this.inFlight.delete(controller);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}
