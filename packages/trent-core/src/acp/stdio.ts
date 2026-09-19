/**
 * The Agent Client Protocol over stdio — what `trent acp` actually is to an editor.
 *
 * ACP is newline-delimited JSON-RPC 2.0 on a subprocess's stdin and stdout: the editor spawns
 * `trent acp`, sends `initialize`, opens a session with `session/new`, and each `session/prompt`
 * streams back `session/update` notifications until the turn ends with a `stopReason`. The previous
 * server spoke JSON-RPC over HTTP on a port, which no editor connects to; that form survives as
 * `trent acp --http` for the existing integrations and tests.
 *
 *   https://agentclientprotocol.com/protocol/initialization
 *   https://agentclientprotocol.com/protocol/session-setup
 *   https://agentclientprotocol.com/protocol/prompt-turn
 *
 * One prompt is one REAL orchestration run on the injected {@link AgentRunner}, and every chunk the
 * editor sees is text that run produced (AGENTS.md invariant 2). With no runtime attached the
 * method returns a JSON-RPC error; it never answers on the runtime's behalf.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentRunFold, NO_RUNNER_REASON, type AgentRunOutcome, type AgentRunner } from "../agent-runner/index.js";
import { ACP_INVALID_PARAMS, ACP_RUNNER_UNAVAILABLE } from "./chat.js";

/** The MAJOR protocol version this agent implements. */
export const ACP_PROTOCOL_VERSION = 1;

export const ACP_METHOD_NOT_FOUND = -32601;
export const ACP_PARSE_ERROR = -32700;

export const ACP_AGENT_NAME = "trent";
export const ACP_CWD_REQUIRED = "session/new requires an absolute `cwd`";
export const ACP_PROMPT_TEXT_REQUIRED = "session/prompt requires a `prompt` with at least one non-empty text block";
export const ACP_UNKNOWN_SESSION = "no session with that id was opened on this connection";

/** The turn's ending, as the protocol names it. */
export type ACPStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  controller: AbortController | undefined;
  cancelled: boolean;
}

export interface ACPStdioOptions {
  /** The agent runtime a prompt turn runs on. Absent, `session/prompt` refuses. */
  readonly runner?: AgentRunner;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Reported to the client on `initialize`. */
  readonly version?: string;
}

/** The outcome statuses that are not a plain completion, and the reason each one gives the editor. */
function stopReasonFor(outcome: AgentRunOutcome, cancelled: boolean): ACPStopReason {
  if (cancelled || outcome.status === "cancelled") return "cancelled";
  return "end_turn";
}

/**
 * One ACP connection. `serve()` reads frames until the input ends, so the process it runs in stays
 * alive exactly as long as the editor keeps the pipe open.
 */
export class ACPStdioAgent {
  private runner: AgentRunner | undefined;
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  private version: string;
  private sessions = new Map<string, Session>();
  private inFlight = new Set<Promise<void>>();
  private initialized = false;

  constructor(options: ACPStdioOptions = {}) {
    this.runner = options.runner;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.version = options.version ?? "1.0.0";
  }

  /** True when a prompt turn will reach a real agent runtime. */
  public hasRunner(): boolean {
    return this.runner !== undefined;
  }

  /** Read frames until the input ends, then wait for every turn still running. */
  public async serve(): Promise<void> {
    let buffer = "";
    this.input.setEncoding?.("utf8");

    await new Promise<void>((resolve) => {
      this.input.on("data", (chunk: string | Buffer) => {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line !== "") this.accept(line);
          index = buffer.indexOf("\n");
        }
      });
      this.input.on("end", () => resolve());
      this.input.on("close", () => resolve());
    });

    // A turn still streaming must finish before the process is allowed to go.
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Stop every turn still running. Used when the host process is shutting down. */
  public abortAll(): void {
    for (const session of this.sessions.values()) {
      session.cancelled = true;
      session.controller?.abort();
    }
  }

  /**
   * One frame in. Deliberately NOT awaited by the read loop: a `session/cancel` notification has to
   * be processed while the `session/prompt` it cancels is still streaming.
   */
  private accept(line: string): void {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: null, error: { code: ACP_PARSE_ERROR, message: (error as Error).message } });
      return;
    }

    const work = this.handle(frame)
      .then((response) => {
        if (response !== undefined) this.write(response);
      })
      .catch((error: unknown) => {
        this.write({
          jsonrpc: "2.0",
          id: frame.id ?? null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => {
        this.inFlight.delete(work);
      });
    this.inFlight.add(work);
  }

  private async handle(frame: JsonRpcFrame): Promise<Record<string, unknown> | undefined> {
    const id = frame.id ?? null;
    const isNotification = frame.id === undefined || frame.id === null;

    switch (frame.method) {
      case "initialize":
        this.initialized = true;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: {
              loadSession: false,
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            agentInfo: { name: ACP_AGENT_NAME, version: this.version },
            // Trent authenticates to model providers from its own profile, so the editor has
            // nothing to log in with and the list is empty rather than invented.
            authMethods: [],
          },
        };

      case "session/new": {
        const cwd = typeof frame.params?.cwd === "string" ? frame.params.cwd : "";
        if (cwd === "" || !path.isAbsolute(cwd)) return this.error(id, ACP_INVALID_PARAMS, ACP_CWD_REQUIRED);
        const session: Session = { id: `sess_${randomUUID()}`, cwd, controller: undefined, cancelled: false };
        this.sessions.set(session.id, session);
        return { jsonrpc: "2.0", id, result: { sessionId: session.id } };
      }

      case "session/prompt":
        return await this.prompt(id, frame.params);

      case "session/cancel": {
        const session = this.sessions.get(String(frame.params?.sessionId ?? ""));
        if (session !== undefined) {
          session.cancelled = true;
          session.controller?.abort();
        }
        // A notification gets no response, per JSON-RPC.
        return isNotification ? undefined : { jsonrpc: "2.0", id, result: null };
      }

      default:
        if (isNotification) return undefined;
        return this.error(id, ACP_METHOD_NOT_FOUND, `no method "${String(frame.method)}" on this agent`);
    }
  }

  /** One prompt turn: one real run, streamed to the editor as the protocol's own updates. */
  private async prompt(id: string | number | null, params: any): Promise<Record<string, unknown>> {
    const session = this.sessions.get(String(params?.sessionId ?? ""));
    if (session === undefined) return this.error(id, ACP_INVALID_PARAMS, ACP_UNKNOWN_SESSION);

    const objective = promptText(params?.prompt);
    if (objective === "") return this.error(id, ACP_INVALID_PARAMS, ACP_PROMPT_TEXT_REQUIRED);

    const runner = this.runner;
    if (runner === undefined) return this.error(id, ACP_RUNNER_UNAVAILABLE, NO_RUNNER_REASON);
    if (!this.initialized) return this.error(id, ACP_INVALID_PARAMS, "the connection was not initialized");

    const controller = new AbortController();
    session.controller = controller;
    session.cancelled = false;

    const fold = createAgentRunFold();
    let outcome: AgentRunOutcome;
    try {
      for await (const event of runner.run({ objective, signal: controller.signal })) {
        const progress = fold.apply(event);
        if (progress !== undefined) this.chunk(session.id, progress);
      }
      outcome = fold.outcome();
    } catch (error) {
      outcome = fold.fail(error);
    } finally {
      session.controller = undefined;
    }

    // The run's own summary is the last thing the editor sees, and the only answer there is.
    if (outcome.status === "completed" && outcome.output !== "") this.chunk(session.id, outcome.output);
    // An approval gate is a question, not an answer: it goes back as the agent's own words and the
    // turn ends, because this connection has no permission channel to ask through.
    if (outcome.status === "input-required") this.chunk(session.id, outcome.question ?? outcome.output);
    if (outcome.status === "failed") return this.error(id, ACP_RUNNER_UNAVAILABLE, outcome.output);

    return { jsonrpc: "2.0", id, result: { stopReason: stopReasonFor(outcome, session.cancelled) } };
  }

  private chunk(sessionId: string, text: string): void {
    this.write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    });
  }

  private error(id: string | number | null, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  private write(frame: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(frame)}\n`);
  }
}

/** The text of an ACP prompt: every text content block, in order. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block): block is { type: string; text: string } => typeof block?.text === "string" && block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
