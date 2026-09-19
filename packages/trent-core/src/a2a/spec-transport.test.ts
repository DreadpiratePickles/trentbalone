/**
 * E3 RED — Trent speaks the A2A specification on the wire.
 *
 * The previous transport was Trent's own payload (`POST /a2a/tasks` with `taskId`/`targetAgent`),
 * which no A2A client can talk to. These tests are written against the published specification, so
 * they fail until the real thing is served:
 *
 *   - the Agent Card at the well-known URI (spec §5.5 / §8.2, `/.well-known/agent-card.json`)
 *   - JSON-RPC 2.0 at the card's own `url`: `message/send`, `message/stream`, `tasks/get`,
 *     `tasks/cancel` (spec §7.1, §7.2, §7.3, §7.4)
 *   - the `TaskState` enum, the `Message`/`Part`/`Artifact` shapes and the two streaming events
 *     (spec §6.3, §6.4, §6.5, §6.6, §7.2.1, §7.2.2)
 *   - the A2A error codes (spec §8.2): -32001 unknown task, -32002 not cancelable,
 *     -32004 unsupported operation, and JSON-RPC's own -32601 / -32602
 *
 * Sources: https://a2a-protocol.org/latest/specification/ and the JSON Schema it is generated
 * from, https://github.com/a2aproject/A2A/blob/v0.3.0/specification/json/a2a.json
 *
 * Every run here is a fake runner replaying a fixed event sequence: no model is ever called, and
 * every assertion is about text the runner itself produced.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner, AgentRunInput } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import {
  A2AServer,
  A2A_WELL_KNOWN_PATH,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_PUSH_NOT_SUPPORTED,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_PROTOCOL_VERSION,
  A2A_SECURITY_SCHEME,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  type A2AAgentCard,
  type A2ATask,
  type A2AStreamEvent,
} from "./index.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_spec", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
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

/** Replays one event sequence per call, in order: turn one, then turn two. */
function queuedRunner(turns: readonly (readonly OrcEvent[])[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  let turn = 0;
  return {
    objectives,
    run(input: AgentRunInput) {
      const events = turns[Math.min(turn, turns.length - 1)] ?? [];
      turn += 1;
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

/** A runner that never finishes on its own: it ends only when the caller's signal aborts. */
function abortableRunner(): AgentRunner & { started: Promise<void> } {
  let announce: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  return {
    started,
    run(input: AgentRunInput) {
      return (async function* () {
        yield ev("run_start", { run: { objective: input.objective } });
        announce();
        await new Promise<void>((resolve) => {
          if (input.signal === undefined) return;
          if (input.signal.aborted) return resolve();
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield ev("run_cancelled");
      })();
    },
  };
}

const DONE = [
  ev("run_start"),
  ev("step_output", { step: { output: "the retry budget is exhausted after three attempts" } }),
  ev("consolidate_end", { run: { summary: "raise the retry ceiling and add a jittered backoff" } }),
  ev("run_done", { run: { status: "completed", summary: "raise the retry ceiling and add a jittered backoff" } }),
];

let open: A2AServer[] = [];

afterEach(async () => {
  for (const server of open) await server.stop();
  open = [];
});

async function serve(runner?: AgentRunner): Promise<A2AServer> {
  const server = new A2AServer(runner === undefined ? { port: 0 } : { port: 0, runner });
  await server.start();
  open.push(server);
  return server;
}

function origin(server: A2AServer): string {
  return `http://127.0.0.1:${server.getPort()}`;
}

let nextId = 0;

async function rpc(url: string, method: string, params?: unknown): Promise<any> {
  nextId += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as any;
}

function userMessage(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "message", role: "user", messageId: `msg-${String((nextId += 1))}`, parts: [{ kind: "text", text }], ...extra };
}

/** Reads an SSE body into the JSON-RPC results it carried, in order. */
async function readSse(res: Response): Promise<A2AStreamEvent[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data:".length)) as { result: A2AStreamEvent })
    .map((envelope) => envelope.result);
}

describe("the Agent Card at the well-known URI", () => {
  it("is served at the specification's path and describes this server", async () => {
    const server = await serve(fakeRunner(DONE));
    const res = await fetch(`${origin(server)}${A2A_WELL_KNOWN_PATH}`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as A2AAgentCard;

    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.name.length).toBeGreaterThan(0);
    expect(card.description.length).toBeGreaterThan(0);
    expect(card.url).toBe(`${origin(server)}/`);
    expect(card.version.length).toBeGreaterThan(0);
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(card.capabilities.streaming).toBe(true);
    expect(card.defaultInputModes).toContain("text/plain");
    expect(card.defaultOutputModes).toContain("text/plain");
  });

  it("derives one skill from each of the nine seats", async () => {
    const server = await serve(fakeRunner(DONE));
    const card = (await (await fetch(`${origin(server)}${A2A_WELL_KNOWN_PATH}`)).json()) as A2AAgentCard;

    expect(card.skills).toHaveLength(9);
    const ids = card.skills.map((skill) => skill.id);
    expect(ids).toContain("ceo");
    expect(ids).toContain("engineer");
    expect(ids).toContain("sales");
    for (const skill of card.skills) {
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
    // The scheme is always declared; `security` is what says it is REQUIRED, and this server
    // was started without a token, so requiring one would be a lie.
    expect(Object.keys(card.securitySchemes ?? {})).toContain(A2A_SECURITY_SCHEME);
    expect(card.security).toBeUndefined();
  });

  it("requires the declared scheme exactly when a token is configured", async () => {
    const server = new A2AServer({ port: 0, runner: fakeRunner(DONE), token: "a-configured-token" });
    await server.start();
    open.push(server);
    const card = (await (await fetch(`${origin(server)}${A2A_WELL_KNOWN_PATH}`)).json()) as A2AAgentCard;
    expect(card.security?.[0]?.[A2A_SECURITY_SCHEME]).toEqual([]);

    const refused = await fetch(`${origin(server)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "anything" } }),
    });
    expect(refused.status).toBe(401);

    const accepted = await fetch(`${origin(server)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer a-configured-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: "anything" } }),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as any).error.code).toBe(A2A_ERROR_TASK_NOT_FOUND);
  });

  it("also answers the pre-0.3 well-known path, so an older client still discovers it", async () => {
    const server = await serve(fakeRunner(DONE));
    const res = await fetch(`${origin(server)}/.well-known/agent.json`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as A2AAgentCard).url).toBe(`${origin(server)}/`);
  });
});

describe("message/send", () => {
  it("runs the injected runtime and returns a completed Task with the run's summary as an Artifact", async () => {
    const runner = fakeRunner(DONE);
    const server = await serve(runner);
    const body = await rpc(`${origin(server)}/`, "message/send", {
      message: userMessage("why does the checkout retry storm?"),
    });

    expect(body.error).toBeUndefined();
    const task = body.result as A2ATask;
    expect(task.kind).toBe("task");
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.contextId.length).toBeGreaterThan(0);
    expect(task.status.state).toBe("completed");
    expect(task.status.timestamp).toMatch(/^\d{4}-/);
    expect(runner.objectives).toEqual(["why does the checkout retry storm?"]);

    const artifact = task.artifacts?.[0];
    expect(artifact?.artifactId.length).toBeGreaterThan(0);
    expect(artifact?.parts[0]).toMatchObject({ kind: "text", text: "raise the retry ceiling and add a jittered backoff" });

    // The caller's own message is the first entry of the task history.
    expect(task.history?.[0]?.role).toBe("user");
    expect(task.history?.[0]?.parts[0]).toMatchObject({ kind: "text" });
  });

  it("fails the task with the run's own reason when the run fails", async () => {
    const server = await serve(fakeRunner([ev("run_start"), ev("run_failed", { detail: "the sandbox refused to start" })]));
    const body = await rpc(`${origin(server)}/`, "message/send", { message: userMessage("build the release") });
    const task = body.result as A2ATask;
    expect(task.status.state).toBe("failed");
    expect(task.status.message?.parts[0]).toMatchObject({ kind: "text", text: "the sandbox refused to start" });
  });

  it("parks on input-required and carries the approval question as a Message", async () => {
    const server = await serve(
      fakeRunner([ev("run_start"), ev("step_awaiting_approval", { detail: "may I delete the staging database?" })]),
    );
    const body = await rpc(`${origin(server)}/`, "message/send", { message: userMessage("clean up staging") });
    const task = body.result as A2ATask;

    expect(task.status.state).toBe("input-required");
    expect(task.status.message?.role).toBe("agent");
    expect(task.status.message?.taskId).toBe(task.id);
    expect(task.status.message?.parts[0]).toMatchObject({ kind: "text", text: "may I delete the staging database?" });
  });

  it("continues a task that is waiting for input, keeping its id and context", async () => {
    // Spec §9.4: the multi-turn shape. The first turn parks on a gate, the client answers it with
    // a second message naming the same task, and that task — not a new one — completes.
    const runner = queuedRunner([[ev("run_start"), ev("run_awaiting_approval", { detail: "which environment?" })], DONE]);
    const server = await serve(runner);
    const first = (await rpc(`${origin(server)}/`, "message/send", { message: userMessage("deploy the release") })).result as A2ATask;
    expect(first.status.state).toBe("input-required");

    const second = (
      await rpc(`${origin(server)}/`, "message/send", {
        message: userMessage("staging", { taskId: first.id, contextId: first.contextId }),
      })
    ).result as A2ATask;

    expect(second.id).toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(second.status.state).toBe("completed");
    expect(second.history?.length).toBe(2);
    expect(runner.objectives).toEqual(["deploy the release", "staging"]);
  });

  it("refuses a message sent to a task that already finished", async () => {
    const server = await serve(fakeRunner(DONE));
    const done = (await rpc(`${origin(server)}/`, "message/send", { message: userMessage("one shot") })).result as A2ATask;
    const again = await rpc(`${origin(server)}/`, "message/send", { message: userMessage("more", { taskId: done.id }) });
    expect(again.error.code).toBe(A2A_ERROR_UNSUPPORTED_OPERATION);
  });

  it("rejects a message with no text part as invalid params, and an unknown taskId as not found", async () => {
    const server = await serve(fakeRunner(DONE));
    const empty = await rpc(`${origin(server)}/`, "message/send", { message: { kind: "message", role: "user", messageId: "m1", parts: [] } });
    expect(empty.error.code).toBe(JSONRPC_INVALID_PARAMS);

    const missing = await rpc(`${origin(server)}/`, "message/send", {
      message: userMessage("continue", { taskId: "task-that-was-never-created" }),
    });
    expect(missing.error.code).toBe(A2A_ERROR_TASK_NOT_FOUND);
  });
});

describe("message/stream", () => {
  it("emits the Task, then TaskStatusUpdateEvent and TaskArtifactUpdateEvent frames from the real event stream", async () => {
    const server = await serve(fakeRunner(DONE));
    const res = await fetch(`${origin(server)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "message/stream", params: { message: userMessage("stream it") } }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);

    const first = events[0] as A2ATask;
    expect(first.kind).toBe("task");
    expect(first.status.state).toBe("submitted");

    const kinds = events.map((e) => (e as { kind: string }).kind);
    expect(kinds).toContain("status-update");
    expect(kinds).toContain("artifact-update");

    const artifactFrames = events.filter((e): e is Extract<A2AStreamEvent, { kind: "artifact-update" }> => e.kind === "artifact-update");
    expect(artifactFrames[0]?.taskId).toBe(first.id);
    expect(artifactFrames[0]?.artifact.parts[0]).toMatchObject({ kind: "text" });
    expect(artifactFrames.at(-1)?.lastChunk).toBe(true);

    const last = events.at(-1) as Extract<A2AStreamEvent, { kind: "status-update" }>;
    expect(last.kind).toBe("status-update");
    expect(last.final).toBe(true);
    expect(last.status.state).toBe("completed");
    expect(last.taskId).toBe(first.id);
    expect(last.contextId).toBe(first.contextId);
  });
});

describe("tasks/get and tasks/cancel", () => {
  it("returns a stored task and reports an unknown id with the specification's code", async () => {
    const server = await serve(fakeRunner(DONE));
    const created = (await rpc(`${origin(server)}/`, "message/send", { message: userMessage("store me") })).result as A2ATask;

    const found = await rpc(`${origin(server)}/`, "tasks/get", { id: created.id });
    expect((found.result as A2ATask).id).toBe(created.id);
    expect((found.result as A2ATask).status.state).toBe("completed");

    const missing = await rpc(`${origin(server)}/`, "tasks/get", { id: "no-such-task" });
    expect(missing.error.code).toBe(A2A_ERROR_TASK_NOT_FOUND);
    expect(missing.result).toBeUndefined();

    // A task that already reached a terminal state cannot be cancelled.
    const terminal = await rpc(`${origin(server)}/`, "tasks/cancel", { id: created.id });
    expect(terminal.error.code).toBe(A2A_ERROR_TASK_NOT_CANCELABLE);
  });

  it("cancels a running task through the runner's AbortSignal", async () => {
    const runner = abortableRunner();
    const server = await serve(runner);

    const res = await fetch(`${origin(server)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "message/stream", params: { message: userMessage("run forever") } }),
    });
    await runner.started;

    // The stream's first frame carries the id; read it without draining the whole body.
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunk = await reader.read();
    const frame = new TextDecoder().decode(chunk.value);
    const first = JSON.parse(frame.split("\n").find((l) => l.startsWith("data:"))!.slice("data:".length)).result as A2ATask;

    const cancelled = await rpc(`${origin(server)}/`, "tasks/cancel", { id: first.id });
    expect((cancelled.result as A2ATask).status.state).toBe("canceled");
    await reader.cancel();

    const after = await rpc(`${origin(server)}/`, "tasks/get", { id: first.id });
    expect((after.result as A2ATask).status.state).toBe("canceled");
  });

  it("reports an unknown method and an unsupported operation with the right codes", async () => {
    const server = await serve(fakeRunner(DONE));
    const unknown = await rpc(`${origin(server)}/`, "tasks/teleport", {});
    expect(unknown.error.code).toBe(JSONRPC_METHOD_NOT_FOUND);

    const resubscribe = await rpc(`${origin(server)}/`, "tasks/resubscribe", { id: "t" });
    expect(resubscribe.error.code).toBe(A2A_ERROR_UNSUPPORTED_OPERATION);

    const push = await rpc(`${origin(server)}/`, "tasks/pushNotificationConfig/set", { taskId: "t" });
    expect(push.error.code).toBe(A2A_ERROR_PUSH_NOT_SUPPORTED);
  });
});

describe("a client written against the specification", () => {
  it("discovers the card and completes a task with nothing Trent-specific in the exchange", async () => {
    const runner = fakeRunner(DONE);
    const server = await serve(runner);

    // A minimal A2A client: fetch the well-known card, then JSON-RPC at the card's own url.
    const card = (await (await fetch(`${origin(server)}${A2A_WELL_KNOWN_PATH}`)).json()) as A2AAgentCard;
    const response = await fetch(card.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "client-1",
        method: "message/send",
        params: {
          message: {
            kind: "message",
            role: "user",
            messageId: "client-msg-1",
            parts: [{ kind: "text", text: "summarise the incident" }],
          },
        },
      }),
    });
    const envelope = (await response.json()) as { jsonrpc: string; id: string; result: A2ATask };

    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.id).toBe("client-1");
    expect(envelope.result.status.state).toBe("completed");
    expect(envelope.result.artifacts?.[0]?.parts[0]).toMatchObject({
      kind: "text",
      text: "raise the retry ceiling and add a jittered backoff",
    });
    expect(runner.objectives).toEqual(["summarise the incident"]);
  });
});
