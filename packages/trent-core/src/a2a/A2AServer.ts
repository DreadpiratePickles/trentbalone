/**
 * The A2A transport: the Agent Card at the well-known URI, and JSON-RPC 2.0 over HTTP at the
 * server root, with `message/stream` as Server-Sent Events (spec §4, §5.5, §7.2).
 *
 * This file is the adapter and nothing else. Validation and state live in `TaskLifecycle.ts`, the
 * method surface in `rpc.ts`, the card in `card.ts`; a change in behaviour belongs in one of those,
 * never here. What IS here is everything a transport owns: routing, the SSE framing, bearer
 * authentication, and the deprecation headers on the pre-specification route in `legacy.ts`.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */

import http from "node:http";
import { generateAgentCard } from "./AgentCard.js";
import { buildAgentCard } from "./card.js";
import { A2ATaskEngine } from "./TaskLifecycle.js";
import { a2aLegacyMetadata, a2aLegacyParams, a2aLegacyTask, A2A_DEPRECATION_HEADERS, type A2ATaskPayload } from "./legacy.js";
import { A2A_STREAM_METHOD, beginStream, dispatchA2A, invalidRequest, jsonRpcError, jsonRpcResult, requestId } from "./rpc.js";
import {
  A2A_LEGACY_WELL_KNOWN_PATH,
  A2A_WELL_KNOWN_PATH,
  JSONRPC_PARSE_ERROR,
  type A2AJsonRpcRequest,
  type A2ATask,
} from "./spec.js";
import type { AgentRunner } from "../agent-runner/index.js";

/** The release this server reports on its card when the caller names none. */
export const A2A_AGENT_VERSION = "1.0.0";

export interface A2AServerOptions {
  /** 0 binds an ephemeral port; `getPort()` then reports the one the OS gave. */
  port?: number;
  /** Signing key for the pre-specification `/a2a/card/:id` route. */
  secret?: string;
  baseUrl?: string;
  /** The release named on the Agent Card. */
  version?: string;
  /**
   * When set, every JSON-RPC request must carry `Authorization: Bearer <token>`, and the card
   * says so. When unset the card carries no `security`, because there is none to carry.
   */
  token?: string;
  /** The agent runtime a task runs on. Absent, every task is refused, never faked. */
  runner?: AgentRunner;
}

/** The message a caller gets when the bearer token is missing or wrong. */
export const A2A_UNAUTHORIZED = "this endpoint requires the bearer token from the profile secrets file";

export class A2AServer {
  private port: number;
  private secret: string;
  private baseUrl: string | undefined;
  private version: string;
  private token: string | undefined;
  private server: http.Server | null = null;
  private running = false;
  private engine: A2ATaskEngine;
  private inFlight = new Set<AbortController>();

  constructor(options?: A2AServerOptions) {
    this.port = options?.port ?? 7895;
    this.secret = options?.secret || "trent-a2a-default-secret";
    this.baseUrl = options?.baseUrl;
    this.version = options?.version ?? A2A_AGENT_VERSION;
    this.token = options?.token;
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

  /** The stored task for an id, in the specification's shape. */
  public getTask(id: string): A2ATask | undefined {
    return this.engine.get(id);
  }

  /** The card this server publishes. `trent a2a card` prints this exact object. */
  public card() {
    return buildAgentCard({
      url: `${this.origin()}/`,
      version: this.version,
      ...(this.token === undefined ? {} : { authenticated: true }),
    });
  }

  public async start(): Promise<void> {
    if (this.running) return;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        const address = this.server?.address();
        if (address !== null && typeof address === "object") this.port = address.port;
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

  private origin(): string {
    return this.baseUrl ?? `http://127.0.0.1:${this.port}`;
  }

  private authorized(req: http.IncomingMessage): boolean {
    if (this.token === undefined) return true;
    const header = req.headers.authorization ?? "";
    return header.startsWith("Bearer ") && header.slice("Bearer ".length).trim() === this.token;
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

    // The card is public by design: it is what a stranger reads to learn how to authenticate.
    if (req.method === "GET" && (url.pathname === A2A_WELL_KNOWN_PATH || url.pathname === A2A_LEGACY_WELL_KNOWN_PATH)) {
      send(res, 200, this.card());
      return;
    }

    if (!this.authorized(req)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      send(res, 401, { error: A2A_UNAUTHORIZED });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/a2a/card/")) {
      this.sendSignedCard(res, url.pathname.replace("/a2a/card/", "").trim() || "ceo");
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/a2a/tasks/")) {
      const id = decodeURIComponent(url.pathname.replace("/a2a/tasks/", "").trim());
      const task = this.engine.get(id);
      for (const [name, value] of Object.entries(A2A_DEPRECATION_HEADERS)) res.setHeader(name, value);
      if (task === undefined) {
        send(res, 404, { error: `no task with id "${id}" was submitted to this server` });
        return;
      }
      send(res, 200, a2aLegacyTask(task, this.engine.states(id)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/a2a/tasks") {
      await this.handleLegacyTask(req, res);
      return;
    }

    if (req.method === "POST") {
      await this.handleRpc(req, res);
      return;
    }

    send(res, 200, { a2a: "trent-fleet", status: "online", runner: this.hasRunner(), card: A2A_WELL_KNOWN_PATH });
  }

  private sendSignedCard(res: http.ServerResponse, agentId: string): void {
    const card = generateAgentCard(
      {
        id: agentId,
        name: `Trent ${agentId.toUpperCase()} Agent`,
        description: `Autonomous cofounder specialist in ${agentId}.`,
        category: "specialist",
        capabilities: ["task-execution", "analysis", "synthesis"],
        endpoint: `${this.origin()}/`,
      },
      this.secret,
    );
    for (const [name, value] of Object.entries(A2A_DEPRECATION_HEADERS)) res.setHeader(name, value);
    send(res, 200, card);
  }

  /** JSON-RPC at the server root. `message/stream` becomes SSE; everything else, one response. */
  private async handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let request: A2AJsonRpcRequest;
    try {
      request = JSON.parse(await readBody(req)) as A2AJsonRpcRequest;
    } catch (err) {
      send(res, 200, jsonRpcError(null, { code: JSONRPC_PARSE_ERROR, message: (err as Error).message }));
      return;
    }

    if (request?.method === A2A_STREAM_METHOD && invalidRequest(request) === undefined) {
      await this.handleStream(request, res);
      return;
    }
    send(res, 200, await dispatchA2A(this.engine, request));
  }

  /** Spec §7.2: each SSE `data:` field is a complete JSON-RPC response for the stream's id. */
  private async handleStream(request: A2AJsonRpcRequest, res: http.ServerResponse): Promise<void> {
    const id = requestId(request);
    const begun = beginStream(this.engine, request);
    if (!begun.ok) {
      send(res, 200, begun.response);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const frame = (result: unknown): boolean => res.write(`data: ${JSON.stringify(jsonRpcResult(id, result))}\n\n`);
    frame(begun.task);

    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      for await (const event of this.engine.stream(begun.task.id, controller.signal)) {
        if (res.writableEnded || res.destroyed) break;
        frame(event);
      }
    } finally {
      this.inFlight.delete(controller);
      if (!res.writableEnded) res.end();
    }
  }

  /** The pre-specification route, kept one release behind a deprecation header. See `legacy.ts`. */
  private async handleLegacyTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(A2A_DEPRECATION_HEADERS)) res.setHeader(name, value);

    let payload: A2ATaskPayload;
    try {
      payload = JSON.parse(await readBody(req)) as A2ATaskPayload;
    } catch (err) {
      send(res, 400, { error: `Invalid task JSON: ${(err as Error).message}` });
      return;
    }

    const begun = this.engine.begin(a2aLegacyParams(payload), a2aLegacyMetadata(payload), { adoptTaskId: true });
    if (!begun.ok) {
      send(res, this.hasRunner() ? 400 : 503, { taskId: payload.taskId, error: begun.error.message });
      return;
    }

    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const outcome = await this.engine.run(begun.task.id, controller.signal);
      if (!outcome.ok) {
        send(res, 400, { taskId: payload.taskId, error: outcome.error.message });
        return;
      }
      send(res, 200, a2aLegacyTask(outcome.task, this.engine.states(outcome.task.id)));
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
