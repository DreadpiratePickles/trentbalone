/**
 * A local A2A peer for the client's and the toolset's tests. It serves an Agent Card in the shape a
 * test asks for (v1.0 only, 0.3.0 only, or both, as Trent's own server does) and answers JSON-RPC
 * `SendMessage` (v1.0) and `message/send` (0.3.0) in that dialect's own shapes, taken from
 * `a2a/v1.ts` and `a2a/spec.ts` and from Hermes v0.21.3's wire as recorded in
 * docs/sessions/2026-09-20-a2a-v1-wire.md. A card that advertises one dialect refuses the other
 * dialect's method with -32601, so a test proves which one the client chose.
 *
 * It records every request (method, path, headers, parsed body) so a test can assert exactly what
 * left the client, including which Authorization header arrived. Nothing here is a real agent and
 * nothing calls a model: the answers are scripted by the test.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { A2ATaskState } from "../../../a2a/spec.js";

export type FakeCardShape = "v1" | "0.3" | "both";

export interface FakeTurn {
  readonly dialect: "1.0" | "0.3.0";
  readonly text: string;
  readonly taskId?: string;
  readonly contextId?: string;
  /** 1 for the first message this peer received, 2 for the second, ... */
  readonly index: number;
}

export interface FakeAnswer {
  readonly state: A2ATaskState;
  /** The artifact text when completed; the status message text otherwise. */
  readonly text: string;
}

export interface FakePeerOptions {
  readonly card?: FakeCardShape;
  readonly name?: string;
  /** When set, every JSON-RPC request must carry exactly this bearer, and the card declares it. */
  readonly token?: string;
  readonly answer?: (turn: FakeTurn) => FakeAnswer;
  /** Serve no card at the current well-known path (only at the pre-0.3 one). */
  readonly legacyCardOnly?: boolean;
}

export interface RecordedPeerRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const v1State = (state: A2ATaskState): string => `TASK_STATE_${state.toUpperCase().replace(/-/g, "_")}`;

export class FakePeer {
  readonly requests: RecordedPeerRequest[] = [];
  private server: http.Server | undefined;
  private base = "";
  private turns = 0;
  private readonly contexts = new Map<string, string>();

  constructor(private readonly options: FakePeerOptions = {}) {}

  get url(): string {
    return this.base;
  }

  /** The JSON-RPC requests, in arrival order. */
  rpc(): RecordedPeerRequest[] {
    return this.requests.filter((request) => request.method === "POST");
  }

  card(): Record<string, unknown> {
    const shape = this.options.card ?? "both";
    const endpoint = `${this.base}/`;
    const common = {
      name: this.options.name ?? "Fake Peer",
      description: "A scripted A2A peer for tests.",
      version: "9.9.9",
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "triage", name: "Triage", description: "Sorts an incident into a queue.", tags: ["support"] }],
      ...(this.options.token === undefined ? {} : { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } }, security: [{ bearerAuth: [] }] }),
    };
    const v1 = { supportedInterfaces: [{ url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] };
    const v03 = { protocolVersion: "0.3.0", url: endpoint, preferredTransport: "JSONRPC" };
    return shape === "v1" ? { ...common, ...v1 } : shape === "0.3" ? { ...common, ...v03 } : { ...common, ...v03, ...v1 };
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.base;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const text = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers[key.toLowerCase()] = value;
    let body: unknown = text;
    try {
      body = text === "" ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = text;
    }
    this.requests.push({ method: (req.method ?? "GET").toUpperCase(), path: url.pathname, headers, body });
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET") {
      const current = url.pathname === "/.well-known/agent-card.json" && this.options.legacyCardOnly !== true;
      if (current || url.pathname === "/.well-known/agent.json") return send(200, this.card());
      return send(404, { error: "not found" });
    }
    if (this.options.token !== undefined && headers.authorization !== `Bearer ${this.options.token}`) return send(401, { error: "unauthorized" });
    const request = body as { id?: unknown; method?: string; params?: { message?: Record<string, unknown> } };
    send(200, this.answer(request));
  }

  private answer(request: { id?: unknown; method?: string; params?: { message?: Record<string, unknown> } }): unknown {
    const id = request.id ?? null;
    const shape = this.options.card ?? "both";
    const dialect = request.method === "SendMessage" ? "1.0" : request.method === "message/send" ? "0.3.0" : undefined;
    const refused = dialect === undefined || (dialect === "1.0" && shape === "0.3") || (dialect === "0.3.0" && shape === "v1");
    if (refused) return { jsonrpc: "2.0", id, error: { code: -32601, message: `no method "${String(request.method)}" on this agent` } };
    const message = request.params?.message ?? {};
    const parts = Array.isArray(message.parts) ? (message.parts as Record<string, unknown>[]) : [];
    const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    this.turns += 1;
    const turn: FakeTurn = {
      dialect,
      text,
      index: this.turns,
      ...(typeof message.taskId === "string" ? { taskId: message.taskId } : {}),
      ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}),
    };
    const answer = this.options.answer?.(turn) ?? { state: "completed", text: `echo: ${text}` };
    const taskId = turn.taskId ?? `task-${this.turns}`;
    const contextId = turn.contextId ?? this.contexts.get(taskId) ?? `ctx-${this.turns}`;
    this.contexts.set(taskId, contextId);
    const timestamp = "2026-09-25T19:00:00.000Z";
    const done = answer.state === "completed";
    if (dialect === "1.0") {
      const part = { text: answer.text, mediaType: "text/plain" };
      const status = { state: v1State(answer.state), timestamp, ...(done ? {} : { message: { messageId: `m-${this.turns}`, taskId, contextId, role: "ROLE_AGENT", parts: [part] } }) };
      return { jsonrpc: "2.0", id, result: { task: { id: taskId, contextId, status, artifacts: done ? [{ artifactId: `a-${this.turns}`, parts: [part] }] : [] } } };
    }
    const part = { kind: "text", text: answer.text };
    const status = { state: answer.state, timestamp, ...(done ? {} : { message: { kind: "message", messageId: `m-${this.turns}`, taskId, contextId, role: "agent", parts: [part] } }) };
    return { jsonrpc: "2.0", id, result: { kind: "task", id: taskId, contextId, status, artifacts: done ? [{ artifactId: `a-${this.turns}`, parts: [part] }] : [] } };
  }
}
