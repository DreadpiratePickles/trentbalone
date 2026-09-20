/**
 * RED — Trent answers A2A v1.0 on the wire, beside 0.3.0.
 *
 * Hermes v0.21.3's outbound client (`plugins/platforms/a2a/tools.py::_send_task`) speaks A2A
 * v1.0: JSON-RPC method `SendMessage`, a `Message` with `role: "ROLE_USER"` and parts
 * `{text, mediaType}` with no `kind`, an `A2A-Version: 1.0` header, and it reads `result.task`
 * (or `.message`), the first text artifact, `contextId` and `status.state`, keying its
 * "needs more input" hint on the literal `TASK_STATE_INPUT_REQUIRED`. The discovery proof
 * (docs/sessions/2026-09-20-hermes-a2a-discovery-proof.md) recorded the 0.3.0 server answering
 * that request with -32601 / -32005 before any task existed.
 *
 * These tests post exactly what Hermes builds and assert exactly what Hermes parses
 * (docs/sessions/2026-09-20-a2a-v1-wire.md, step 1). The 0.3.0 tests in spec-transport.test.ts
 * are untouched and must stay green: one task lifecycle, two dialects at the edge.
 *
 * Sources: https://a2a-protocol.org/latest/specification/ (v1.0) and the Hermes source named above.
 * Every run here is a fake runner replaying a fixed event sequence: no model is ever called.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunner, AgentRunInput } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import {
  A2AServer,
  A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED,
  A2A_ERROR_PUSH_NOT_SUPPORTED,
  A2A_ERROR_TASK_NOT_CANCELABLE,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_PROTOCOL_VERSION,
  A2A_WELL_KNOWN_PATH,
  JSONRPC_INVALID_PARAMS,
  type A2AAgentCard,
  type A2ATask,
} from "./index.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_v1", at: "2026-09-20T00:00:00.000Z", ...extra } as OrcEvent;
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

const SUMMARY = "raise the retry ceiling and add a jittered backoff";
const DONE = [
  ev("run_start"),
  ev("step_output", { step: { output: "the retry budget is exhausted after three attempts" } }),
  ev("consolidate_end", { run: { summary: SUMMARY } }),
  ev("run_done", { run: { status: "completed", summary: SUMMARY } }),
];

let open: A2AServer[] = [];

afterEach(async () => {
  for (const server of open) await server.stop();
  open = [];
});

async function serve(runner: AgentRunner): Promise<A2AServer> {
  const server = new A2AServer({ port: 0, runner });
  await server.start();
  open.push(server);
  return server;
}

function origin(server: A2AServer): string {
  return `http://127.0.0.1:${server.getPort()}`;
}

let seq = 0;

/** Exactly `protocol.text_message(ROLE_USER, text, context_id)` in Hermes: no `kind`, no `taskId`. */
function hermesMessage(text: string, contextId = "ctx-probe", extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { role: "ROLE_USER", parts: [{ text, mediaType: "text/plain" }], messageId: `${String(seq).padStart(32, "0")}`, contextId, ...extra };
}

/** Exactly `_http_post_json` in Hermes: the body, `Content-Type` and `A2A-Version: 1.0`. */
async function hermesPost(url: string, method: string, params: unknown): Promise<{ status: number; version: string | null; body: any }> {
  seq += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `task-${String(seq)}`, method, params }),
  });
  return { status: res.status, version: res.headers.get("A2A-Version"), body: (await res.json()) as any };
}

/** The 0.3.0 client from spec-transport.test.ts, unchanged: no version header, `kind` on everything. */
async function rpc03(url: string, method: string, params?: unknown): Promise<{ version: string | null; body: any }> {
  seq += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: seq, method, ...(params === undefined ? {} : { params }) }),
  });
  return { version: res.headers.get("A2A-Version"), body: (await res.json()) as any };
}

/** Hermes's `protocol.unwrap_send_message_response` + `_reply_text_from_result`, line for line. */
function hermesReply(result: any): { payload: any; text: string; contextId: string | undefined; state: string } {
  const payload = typeof result?.task === "object" ? result.task : typeof result?.message === "object" ? result.message : result;
  const extract = (m: any): string =>
    ((m?.parts ?? []) as any[])
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter((t) => t !== "")
      .join("\n")
      .trim();
  let text = "";
  for (const artifact of payload?.artifacts ?? []) {
    text = extract(artifact);
    if (text !== "") break;
  }
  if (text === "") text = extract(payload?.status?.message ?? payload);
  return { payload, text, contextId: payload?.contextId, state: payload?.status?.state ?? "" };
}

async function readSse(res: Response): Promise<any[]> {
  const body = await res.text();
  return body
    .split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data:")))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice("data:".length)) as { result: unknown })
    .map((envelope) => envelope.result);
}

describe("SendMessage — what Hermes's a2a_call sends", () => {
  it("lands in the task lifecycle and answers the v1.0 SendMessageResponse Hermes parses", async () => {
    const runner = fakeRunner(DONE);
    const server = await serve(runner);
    const { status, version, body } = await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("why does the checkout retry storm?") });

    expect(status).toBe(200);
    expect(version).toBe("1.0");
    expect(body.error).toBeUndefined();
    expect(runner.objectives).toEqual(["why does the checkout retry storm?"]);

    // v1.0 oneof envelope: `result.task`, and the Task itself carries no 0.3 `kind`.
    const task = body.result.task;
    expect(task).toBeDefined();
    expect(body.result.message).toBeUndefined();
    expect(task.kind).toBeUndefined();
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.contextId).toBe("ctx-probe");
    expect(task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(task.status.timestamp).toMatch(/^\d{4}-/);

    // The artifact is the run's own summary as a v1.0 text Part: member-presence, no `kind`.
    expect(task.artifacts[0].artifactId.length).toBeGreaterThan(0);
    expect(task.artifacts[0].parts[0]).toEqual({ text: SUMMARY, mediaType: "text/plain" });

    // The caller's message comes back in history in v1.0 spelling.
    expect(task.history[0].role).toBe("ROLE_USER");
    expect(task.history[0].kind).toBeUndefined();
    expect(task.history[0].parts[0]).toEqual({ text: "why does the checkout retry storm?", mediaType: "text/plain" });

    // What Hermes's own reader would print.
    const reply = hermesReply(body.result);
    expect(reply.text).toBe(SUMMARY);
    expect(reply.contextId).toBe("ctx-probe");
    expect(reply.state).toBe("TASK_STATE_COMPLETED");
  });

  it("carries the gate's own question as TASK_STATE_INPUT_REQUIRED, the literal Hermes keys its hint on", async () => {
    const runner = queuedRunner([[ev("run_start"), ev("run_awaiting_approval", { detail: "which environment?" })], DONE]);
    const server = await serve(runner);
    const first = (await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("deploy the release") })).body.result.task;

    expect(first.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(first.status.message.role).toBe("ROLE_AGENT");
    expect(first.status.message.kind).toBeUndefined();
    expect(first.status.message.taskId).toBe(first.id);
    expect(first.status.message.parts[0]).toEqual({ text: "which environment?", mediaType: "text/plain" });
    expect(hermesReply({ task: first }).text).toBe("which environment?");

    // A v1.0 client that names the task continues it (spec multi-turn); same id, same context.
    const second = (
      await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("staging", first.contextId, { taskId: first.id }) })
    ).body.result.task;
    expect(second.id).toBe(first.id);
    expect(second.contextId).toBe(first.contextId);
    expect(second.status.state).toBe("TASK_STATE_COMPLETED");
    expect(second.history).toHaveLength(2);
    expect(runner.objectives).toEqual(["deploy the release", "staging"]);
  });

  it("fails the task with the run's own reason as TASK_STATE_FAILED", async () => {
    const server = await serve(fakeRunner([ev("run_start"), ev("run_failed", { detail: "the sandbox refused to start" })]));
    const task = (await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("build the release") })).body.result.task;
    expect(task.status.state).toBe("TASK_STATE_FAILED");
    expect(task.status.message.parts[0]).toEqual({ text: "the sandbox refused to start", mediaType: "text/plain" });
  });

  it("refuses a v1.0 file or data part with -32005, and a message without text with -32602", async () => {
    const server = await serve(fakeRunner(DONE));
    const file = await hermesPost(`${origin(server)}/`, "SendMessage", {
      message: { role: "ROLE_USER", messageId: "f1", parts: [{ url: "https://example.invalid/report.pdf", mediaType: "application/pdf" }] },
    });
    expect(file.body.error.code).toBe(A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED);

    const data = await hermesPost(`${origin(server)}/`, "SendMessage", {
      message: { role: "ROLE_USER", messageId: "d1", parts: [{ data: { a: 1 }, mediaType: "application/json" }] },
    });
    expect(data.body.error.code).toBe(A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED);

    const empty = await hermesPost(`${origin(server)}/`, "SendMessage", { message: { role: "ROLE_USER", messageId: "e1", parts: [] } });
    expect(empty.body.error.code).toBe(JSONRPC_INVALID_PARAMS);

    const none = await hermesPost(`${origin(server)}/`, "SendMessage", {});
    expect(none.body.error.code).toBe(JSONRPC_INVALID_PARAMS);

    const missing = await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("continue", "ctx-x", { taskId: "never-created" }) });
    expect(missing.body.error.code).toBe(A2A_ERROR_TASK_NOT_FOUND);
  });
});

describe("one lifecycle, two dialects", () => {
  it("GetTask reads the task SendMessage created, and 0.3 tasks/get reads the very same record", async () => {
    const server = await serve(fakeRunner(DONE));
    const created = (await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("store me") })).body.result.task;

    // v1.0 GetTask answers the bare Task (no oneof wrapper), in v1.0 spelling.
    const got = await hermesPost(`${origin(server)}/`, "GetTask", { id: created.id });
    expect(got.version).toBe("1.0");
    expect(got.body.result.id).toBe(created.id);
    expect(got.body.result.task).toBeUndefined();
    expect(got.body.result.kind).toBeUndefined();
    expect(got.body.result.status.state).toBe("TASK_STATE_COMPLETED");
    expect(got.body.result.artifacts[0].parts[0]).toEqual({ text: SUMMARY, mediaType: "text/plain" });

    // `historyLength` still trims, as in 0.3.
    const trimmed = await hermesPost(`${origin(server)}/`, "GetTask", { id: created.id, historyLength: 0 });
    expect(trimmed.body.result.history).toEqual([]);

    // The 0.3 client sees the same task in its own dialect, byte-for-byte as before.
    const spec = await rpc03(`${origin(server)}/`, "tasks/get", { id: created.id });
    expect(spec.version).toBeNull();
    const task = spec.body.result as A2ATask;
    expect(task.kind).toBe("task");
    expect(task.id).toBe(created.id);
    expect(task.status.state).toBe("completed");
    expect(task.history?.[0]).toMatchObject({ kind: "message", role: "user" });
    expect(task.history?.[0]?.parts[0]).toEqual({ kind: "text", text: "store me" });
    expect(task.artifacts?.[0]?.parts[0]).toEqual({ kind: "text", text: SUMMARY });

    const unknown = await hermesPost(`${origin(server)}/`, "GetTask", { id: "no-such-task" });
    expect(unknown.body.error.code).toBe(A2A_ERROR_TASK_NOT_FOUND);
  });

  it("CancelTask, ListTasks, SubscribeToTask and the push-config methods answer with the specification's codes", async () => {
    const server = await serve(fakeRunner(DONE));
    const created = (await hermesPost(`${origin(server)}/`, "SendMessage", { message: hermesMessage("one shot") })).body.result.task;

    const terminal = await hermesPost(`${origin(server)}/`, "CancelTask", { id: created.id });
    expect(terminal.body.error.code).toBe(A2A_ERROR_TASK_NOT_CANCELABLE);

    const list = await hermesPost(`${origin(server)}/`, "ListTasks", {});
    expect(list.body.error.code).toBe(A2A_ERROR_UNSUPPORTED_OPERATION);

    const subscribe = await hermesPost(`${origin(server)}/`, "SubscribeToTask", { id: created.id });
    expect(subscribe.body.error.code).toBe(A2A_ERROR_UNSUPPORTED_OPERATION);

    const push = await hermesPost(`${origin(server)}/`, "CreateTaskPushNotificationConfig", { taskId: created.id });
    expect(push.body.error.code).toBe(A2A_ERROR_PUSH_NOT_SUPPORTED);

    const extended = await hermesPost(`${origin(server)}/`, "GetExtendedAgentCard", {});
    expect(extended.body.error.code).toBe(A2A_ERROR_UNSUPPORTED_OPERATION);
  });

  it("keeps the 0.3.0 contract exact: message/send with v1.0 parts is still -32005 and carries no version header", async () => {
    // The dialect is the METHOD NAME. A 0.3 method with v1.0 parts is the mixed request the
    // discovery proof recorded, and it gets the same answer it got then.
    const server = await serve(fakeRunner(DONE));
    const mixed = await rpc03(`${origin(server)}/`, "message/send", { message: hermesMessage("probe: never executed") });
    expect(mixed.version).toBeNull();
    expect(mixed.body.error.code).toBe(A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED);
  });
});

describe("SendStreamingMessage", () => {
  it("frames v1.0 StreamResponses: {task}, {statusUpdate}, {artifactUpdate}, terminal {statusUpdate}", async () => {
    const server = await serve(fakeRunner(DONE));
    const res = await fetch(`${origin(server)}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "A2A-Version": "1.0", Accept: "text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "task-stream", method: "SendStreamingMessage", params: { message: hermesMessage("stream it") } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("A2A-Version")).toBe("1.0");
    const frames = await readSse(res);

    expect(frames[0].task.status.state).toBe("TASK_STATE_SUBMITTED");
    expect(frames[0].task.kind).toBeUndefined();
    const taskId = frames[0].task.id as string;

    const statuses = frames.filter((f) => f.statusUpdate !== undefined).map((f) => f.statusUpdate);
    const artifacts = frames.filter((f) => f.artifactUpdate !== undefined).map((f) => f.artifactUpdate);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0].status.state).toBe("TASK_STATE_WORKING");
    expect(statuses[0].taskId).toBe(taskId);
    expect(statuses[0].kind).toBeUndefined();
    expect(statuses[0].final).toBeUndefined();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].taskId).toBe(taskId);
    expect(artifacts[0].lastChunk).toBe(true);
    expect(artifacts[0].artifact.parts[0]).toEqual({ text: SUMMARY, mediaType: "text/plain" });
    expect(artifacts[0].kind).toBeUndefined();

    const last = frames.at(-1);
    expect(last.statusUpdate.status.state).toBe("TASK_STATE_COMPLETED");
    // Every frame is a v1.0 oneof: exactly one member set, and never a 0.3 `kind`.
    for (const frame of frames) {
      expect(Object.keys(frame)).toHaveLength(1);
      expect(["task", "message", "statusUpdate", "artifactUpdate"]).toContain(Object.keys(frame)[0]);
    }
  });
});

describe("the Agent Card advertises what the endpoint now honours", () => {
  it("carries a v1.0 JSONRPC interface at the same url beside the 0.3.0 fields", async () => {
    const server = await serve(fakeRunner(DONE));
    const card = (await (await fetch(`${origin(server)}${A2A_WELL_KNOWN_PATH}`)).json()) as A2AAgentCard;

    // 0.3.0 discovery is unchanged.
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    expect(card.url).toBe(`${origin(server)}/`);
    expect(card.preferredTransport).toBe("JSONRPC");

    // v1.0 discovery: Hermes's `_select_jsonrpc_interface` picks this and `a2a_discover` prints
    // `Protocol: JSONRPC v1.0` instead of the `(pre-1.0 card)` warning.
    expect(card.supportedInterfaces).toEqual([{ url: `${origin(server)}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    expect(card.capabilities.extendedAgentCard).toBe(false);
    const label = (card.supportedInterfaces ?? []).map((i) => `${i.protocolBinding} v${i.protocolVersion}`).join(", ");
    expect(label).toBe("JSONRPC v1.0");
  });
});
