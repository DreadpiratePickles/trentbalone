/**
 * A message carrying a `contextId` and no `taskId`, and the error texts a v1.0 request gets.
 *
 * Hermes v0.21.3's `a2a_call` continues an exchange by `contextId` only and never sends a
 * `taskId`, so when a Trent task parks `input-required` its answer arrives without a task id.
 * Before writing these tests the specification was read (docs/sessions/2026-09-20-a2a-context-
 * continuation.md, step 1). A2A v1.0 §3.4.3 says the client "MAY use contextId without taskId
 * to start a new task within an existing conversation context", and that an input-required
 * task is continued "by sending a new message with the same taskId and contextId". So a
 * `taskId`-less message is a NEW task in that context, in both dialects, and the waiting task
 * keeps waiting for the message that names it. The first block pins that rule; it is the
 * lifecycle's existing behaviour and these tests were green from the start (no lifecycle change
 * was made, on purpose).
 *
 * The second block was RED first: a v1.0-named request used to get error texts naming the
 * 0.3.0 method (`tasks/get requires a string "id"`) and 0.3.0 enum (`is completed`). A v1.0
 * client is told `GetTask` and `TASK_STATE_COMPLETED`; every 0.3.0 text is asserted unchanged.
 *
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
  A2A_MESSAGE_REQUIRED,
  A2A_TEXT_PARTS_ONLY,
  JSONRPC_INVALID_PARAMS,
  type A2ATask,
} from "./index.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_ctx", at: "2026-09-20T00:00:00.000Z", ...extra } as OrcEvent;
}

/** Replays one event sequence per `run` call, in order; the last sequence repeats. */
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
const DONE = [ev("run_start"), ev("consolidate_end", { run: { summary: SUMMARY } }), ev("run_done", { run: { status: "completed", summary: SUMMARY } })];
const PARK = (question: string) => [ev("run_start"), ev("run_awaiting_approval", { detail: question })];

let open: A2AServer[] = [];

afterEach(async () => {
  for (const server of open) await server.stop();
  open = [];
});

async function serve(runner: AgentRunner): Promise<string> {
  const server = new A2AServer({ port: 0, runner });
  await server.start();
  open.push(server);
  return `http://127.0.0.1:${server.getPort()}/`;
}

let seq = 0;

/** Exactly `protocol.text_message(ROLE_USER, text, context_id)` in Hermes: no `kind`, no `taskId`. */
function hermesMessage(text: string, contextId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { role: "ROLE_USER", parts: [{ text, mediaType: "text/plain" }], messageId: String(seq).padStart(32, "0"), contextId, ...extra };
}

/** The 0.3.0 client: `kind` on everything, no version header. */
function specMessage(text: string, contextId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return { kind: "message", role: "user", messageId: `msg-${String(seq)}`, parts: [{ kind: "text", text }], contextId, ...extra };
}

async function post(url: string, method: string, params: unknown, v1: boolean): Promise<any> {
  seq += 1;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(v1 ? { "A2A-Version": "1.0" } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: seq, method, params }),
  });
  return (await res.json()) as any;
}

const v1 = (url: string, method: string, params: unknown) => post(url, method, params, true);
const v03 = (url: string, method: string, params: unknown) => post(url, method, params, false);

describe("a message with contextId and no taskId (spec §3.4.3: a new task in that context)", () => {
  it("v1.0: starts a new task beside the waiting one, which only a message naming its taskId continues", async () => {
    const runner = queuedRunner([PARK("which environment?"), DONE]);
    const url = await serve(runner);
    const first = (await v1(url, "SendMessage", { message: hermesMessage("deploy the release", "ctx-hermes") })).result.task;
    expect(first.status.state).toBe("TASK_STATE_INPUT_REQUIRED");

    // What Hermes's a2a_call sends next: same contextId, still no taskId.
    const second = (await v1(url, "SendMessage", { message: hermesMessage("staging", "ctx-hermes") })).result.task;
    expect(second.id).not.toBe(first.id);
    expect(second.contextId).toBe("ctx-hermes");
    expect(second.history).toHaveLength(1);
    expect(second.status.state).toBe("TASK_STATE_COMPLETED");
    expect(runner.objectives).toEqual(["deploy the release", "staging"]);

    // The waiting task was not touched: same state, its own single message, no invented metadata.
    const waiting = (await v1(url, "GetTask", { id: first.id })).result;
    expect(waiting.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(waiting.history).toHaveLength(1);
    expect(waiting.metadata.continuedBy).toBeUndefined();

    // The specification's continuation, unchanged: the message that names the task continues it.
    const answered = (await v1(url, "SendMessage", { message: hermesMessage("staging", "ctx-hermes", { taskId: first.id }) })).result.task;
    expect(answered.id).toBe(first.id);
    expect(answered.history).toHaveLength(2);
    expect(answered.status.state).toBe("TASK_STATE_COMPLETED");
    expect(runner.objectives).toHaveLength(3);
  });

  it("0.3.0: the same rule, because it lives in the lifecycle below the dialect layer", async () => {
    const runner = queuedRunner([PARK("which environment?"), DONE]);
    const url = await serve(runner);
    const first = (await v03(url, "message/send", { message: specMessage("deploy the release", "ctx-spec") })).result as A2ATask;
    expect(first.status.state).toBe("input-required");

    const second = (await v03(url, "message/send", { message: specMessage("staging", "ctx-spec") })).result as A2ATask;
    expect(second.id).not.toBe(first.id);
    expect(second.contextId).toBe("ctx-spec");
    expect(second.history).toHaveLength(1);
    expect(second.status.state).toBe("completed");

    const waiting = (await v03(url, "tasks/get", { id: first.id })).result as A2ATask;
    expect(waiting.status.state).toBe("input-required");
    expect(waiting.history).toHaveLength(1);

    const answered = (await v03(url, "message/send", { message: specMessage("staging", "ctx-spec", { taskId: first.id }) })).result as A2ATask;
    expect(answered.id).toBe(first.id);
    expect(answered.status.state).toBe("completed");
    expect(runner.objectives).toEqual(["deploy the release", "staging", "staging"]);
  });

  it("the lifecycle can hold several waiting tasks in one context, each continued only by its own taskId", async () => {
    const runner = queuedRunner([PARK("which environment?"), PARK("which region?"), DONE]);
    const url = await serve(runner);
    const a = (await v1(url, "SendMessage", { message: hermesMessage("deploy the release", "ctx-two") })).result.task;
    const b = (await v1(url, "SendMessage", { message: hermesMessage("migrate the database", "ctx-two") })).result.task;
    expect(a.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(b.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(a.id).not.toBe(b.id);
    expect(b.contextId).toBe(a.contextId);

    // Answering the older one by taskId settles it and leaves the newer one waiting.
    const answered = (await v1(url, "SendMessage", { message: hermesMessage("staging", "ctx-two", { taskId: a.id }) })).result.task;
    expect(answered.id).toBe(a.id);
    expect(answered.status.state).toBe("TASK_STATE_COMPLETED");
    expect((await v1(url, "GetTask", { id: b.id })).result.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
    expect(runner.objectives).toEqual(["deploy the release", "migrate the database", "staging"]);
  });
});

describe("a v1.0 request's error texts name v1.0 methods and enums; 0.3.0 texts are unchanged", () => {
  it("-32602: the message-required text names SendMessage, and message/send for a 0.3.0 client", async () => {
    const url = await serve(queuedRunner([DONE]));
    expect((await v1(url, "SendMessage", {})).error).toEqual({ code: JSONRPC_INVALID_PARAMS, message: "SendMessage requires a `message` with at least one non-empty text part" });
    expect((await v1(url, "SendStreamingMessage", {})).error.message).toBe("SendMessage requires a `message` with at least one non-empty text part");
    expect((await v03(url, "message/send", {})).error).toEqual({ code: JSONRPC_INVALID_PARAMS, message: A2A_MESSAGE_REQUIRED });
    expect(A2A_MESSAGE_REQUIRED.startsWith("message/send requires")).toBe(true);
  });

  it('-32602: GetTask and CancelTask say "GetTask requires a string \\"id\\"", tasks/get and tasks/cancel say their own names', async () => {
    const url = await serve(queuedRunner([DONE]));
    expect((await v1(url, "GetTask", {})).error).toEqual({ code: JSONRPC_INVALID_PARAMS, message: 'GetTask requires a string "id"' });
    expect((await v1(url, "CancelTask", {})).error).toEqual({ code: JSONRPC_INVALID_PARAMS, message: 'CancelTask requires a string "id"' });
    expect((await v03(url, "tasks/get", {})).error.message).toBe('tasks/get requires a string "id"');
    expect((await v03(url, "tasks/cancel", {})).error.message).toBe('tasks/cancel requires a string "id"');
  });

  it("-32002 and -32004 on a finished task spell the state TASK_STATE_COMPLETED for v1.0 and completed for 0.3.0", async () => {
    const url = await serve(queuedRunner([DONE]));
    const done = (await v1(url, "SendMessage", { message: hermesMessage("one shot", "ctx-done") })).result.task;

    expect((await v1(url, "CancelTask", { id: done.id })).error).toEqual({ code: A2A_ERROR_TASK_NOT_CANCELABLE, message: `task "${done.id}" is TASK_STATE_COMPLETED` });
    expect((await v1(url, "SendMessage", { message: hermesMessage("more", "ctx-done", { taskId: done.id }) })).error).toEqual({
      code: A2A_ERROR_UNSUPPORTED_OPERATION,
      message: `task "${done.id}" is TASK_STATE_COMPLETED and takes no further messages`,
    });

    expect((await v03(url, "tasks/cancel", { id: done.id })).error.message).toBe(`task "${done.id}" is completed`);
    expect((await v03(url, "message/send", { message: specMessage("more", "ctx-done", { taskId: done.id }) })).error.message).toBe(
      `task "${done.id}" is completed and takes no further messages`,
    );
  });

  it("texts that name no method or enum are identical in both dialects", async () => {
    const url = await serve(queuedRunner([DONE]));
    const file = { role: "ROLE_USER", messageId: "f1", parts: [{ url: "https://example.invalid/r.pdf", mediaType: "application/pdf" }] };
    expect((await v1(url, "SendMessage", { message: file })).error).toEqual({ code: A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED, message: A2A_TEXT_PARTS_ONLY });

    const missing = await v1(url, "GetTask", { id: "no-such-task" });
    expect(missing.error).toEqual({ code: A2A_ERROR_TASK_NOT_FOUND, message: 'no task with id "no-such-task" exists here' });
    expect((await v03(url, "tasks/get", { id: "no-such-task" })).error).toEqual(missing.error);

    const pairs: [string, string, unknown][] = [
      ["SubscribeToTask", "tasks/resubscribe", { id: "t" }],
      ["CreateTaskPushNotificationConfig", "tasks/pushNotificationConfig/set", { taskId: "t" }],
      ["GetExtendedAgentCard", "agent/getAuthenticatedExtendedCard", {}],
    ];
    for (const [v1Method, specMethod, params] of pairs) {
      const a = (await v1(url, v1Method, params)).error;
      const b = (await v03(url, specMethod, params)).error;
      expect(a).toEqual(b);
      expect(a.message).not.toMatch(/\//);
    }
    expect((await v1(url, "CreateTaskPushNotificationConfig", {})).error.code).toBe(A2A_ERROR_PUSH_NOT_SUPPORTED);
    expect((await v1(url, "ListTasks", {})).error).toEqual({ code: A2A_ERROR_UNSUPPORTED_OPERATION, message: "this agent does not list tasks; read one with GetTask" });
  });
});
