/**
 * E3 RED — `trent acp` speaks the Agent Client Protocol over stdio.
 *
 * The ACP server shipped as JSON-RPC over HTTP on port 7890, which no editor knows how to talk to:
 * the protocol is newline-delimited JSON-RPC 2.0 over a subprocess's stdin and stdout. These tests
 * are written against the published protocol and fail until that transport exists:
 *
 *   https://agentclientprotocol.com/protocol/initialization  (`initialize`, protocolVersion 1)
 *   https://agentclientprotocol.com/protocol/session-setup   (`session/new`, absolute `cwd`)
 *   https://agentclientprotocol.com/protocol/prompt-turn     (`session/prompt`, `session/update`,
 *                                                             `session/cancel`, `stopReason`)
 *
 * The runner is fake in every case: the assertions are about text the runner produced.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { AgentRunInput, AgentRunner } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { ACPStdioAgent, ACP_PROTOCOL_VERSION, ACP_RUNNER_UNAVAILABLE, ACP_INVALID_PARAMS } from "./index.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_acp", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

function fakeRunner(events: readonly OrcEvent[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  return {
    objectives,
    run(input: AgentRunInput) {
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

/** A runner that ends only when the caller's signal aborts, so cancellation is observable. */
function abortableRunner(): AgentRunner & { started: Promise<void> } {
  let announce: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    started,
    run(input: AgentRunInput) {
      return (async function* () {
        yield ev("run_start");
        announce();
        await new Promise<void>((resolve) => {
          if (input.signal === undefined || input.signal.aborted) return resolve();
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield ev("run_cancelled");
      })();
    },
  };
}

interface Frame {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
  params?: any;
}

/** Drives an agent over a pair of pipes, exactly as an editor would over a subprocess. */
function harness(runner?: AgentRunner) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== "") frames.push(JSON.parse(line) as Frame);
      index = buffer.indexOf("\n");
    }
    for (const waiter of waiters.splice(0)) waiter();
  });

  const agent = new ACPStdioAgent({ input, output, ...(runner === undefined ? {} : { runner }) });
  const served = agent.serve();

  const send = (frame: Record<string, unknown>): void => {
    input.write(`${JSON.stringify(frame)}\n`);
  };
  const waitFor = async (match: (f: Frame) => boolean): Promise<Frame> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = frames.find(match);
      if (found !== undefined) return found;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 5);
      });
    }
    throw new Error(`no frame matched; saw ${JSON.stringify(frames)}`);
  };
  const close = async (): Promise<void> => {
    input.end();
    await served;
  };
  return { frames, send, waitFor, close };
}

const answer = "the p99 regression is the new synchronous audit write";
const DONE = [
  ev("run_start"),
  ev("step_output", { step: { output: "compared the last two deploys" } }),
  ev("run_done", { run: { status: "completed", summary: answer } }),
];

async function newSession(h: ReturnType<typeof harness>): Promise<string> {
  h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} } });
  await h.waitFor((f) => f.id === 1);
  h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
  const created = await h.waitFor((f) => f.id === 2);
  return created.result.sessionId as string;
}

describe("ACP over stdio", () => {
  it("answers initialize with the protocol version and its own capabilities", async () => {
    const h = harness(fakeRunner(DONE));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} } });
    const reply = await h.waitFor((f) => f.id === 1);

    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(reply.result.agentCapabilities).toBeDefined();
    expect(reply.result.agentInfo.name.length).toBeGreaterThan(0);
    expect(reply.result.authMethods).toEqual([]);
    await h.close();
  });

  it("creates a session and refuses a working directory that is not absolute", async () => {
    const h = harness(fakeRunner(DONE));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: ACP_PROTOCOL_VERSION } });
    await h.waitFor((f) => f.id === 1);

    h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "./relative", mcpServers: [] } });
    const refused = await h.waitFor((f) => f.id === 2);
    expect(refused.error?.code).toBe(ACP_INVALID_PARAMS);

    h.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
    const created = await h.waitFor((f) => f.id === 3);
    expect(typeof created.result.sessionId).toBe("string");
    expect((created.result.sessionId as string).length).toBeGreaterThan(0);
    await h.close();
  });

  it("streams the run's own events as session/update notifications and ends the turn", async () => {
    const runner = fakeRunner(DONE);
    const h = harness(runner);
    const sessionId = await newSession(h);

    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "why did latency double?" }] },
    });
    const done = await h.waitFor((f) => f.id === 3);

    expect(done.result.stopReason).toBe("end_turn");
    expect(runner.objectives).toEqual(["why did latency double?"]);

    const updates = h.frames.filter((f) => f.method === "session/update");
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) expect(update.params.sessionId).toBe(sessionId);
    const texts = updates
      .filter((u) => u.params.update.sessionUpdate === "agent_message_chunk")
      .map((u) => u.params.update.content.text as string);
    expect(texts).toContain("compared the last two deploys");
    expect(texts).toContain(answer);
    // Nothing the agent said was written here: every chunk came off the run's event stream.
    expect(texts.join("")).not.toContain("prompt");
    await h.close();
  });

  it("ends the turn as cancelled when the client sends session/cancel", async () => {
    const runner = abortableRunner();
    const h = harness(runner);
    const sessionId = await newSession(h);

    h.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "run forever" }] } });
    await runner.started;
    h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

    const done = await h.waitFor((f) => f.id === 3);
    expect(done.result.stopReason).toBe("cancelled");
    await h.close();
  });

  it("refuses a prompt with no runtime, an unknown session, and an unknown method", async () => {
    const h = harness();
    const sessionId = await newSession(h);

    h.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "anything" }] } });
    const noRuntime = await h.waitFor((f) => f.id === 3);
    expect(noRuntime.error?.code).toBe(ACP_RUNNER_UNAVAILABLE);
    expect(noRuntime.result).toBeUndefined();

    h.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "sess-nope", prompt: [{ type: "text", text: "x" }] } });
    expect((await h.waitFor((f) => f.id === 4)).error?.code).toBe(ACP_INVALID_PARAMS);

    h.send({ jsonrpc: "2.0", id: 5, method: "session/teleport", params: {} });
    expect((await h.waitFor((f) => f.id === 5)).error?.code).toBe(-32601);
    await h.close();
  });
});
