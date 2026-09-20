/**
 * The A2A v1.0 dialect at the JSON-RPC edge: a translation table over the 0.3.0 internals.
 *
 * Trent's task lifecycle (`TaskLifecycle.ts`) speaks the 0.3.0 data model in `spec.ts`. A2A v1.0
 * renamed the JSON-RPC methods (`SendMessage` for `message/send`), turned the enums into
 * SCREAMING_SNAKE_CASE (`TASK_STATE_COMPLETED`, `ROLE_USER`), discriminates a `Part` by which
 * member it carries (`{text}`, `{url|raw}`, `{data}`) instead of a `kind`, dropped `kind` from
 * every object, wraps the `SendMessage` result in a oneof (`{task}` or `{message}`), and frames a
 * stream as `{task}` / `{statusUpdate}` / `{artifactUpdate}` with no `final` flag. Nothing about
 * what a task IS changed, so nothing in the lifecycle changes: this file maps names in and names
 * out, and the dialect of a request is decided by its METHOD NAME alone. A 0.3 method with v1.0
 * parts is answered exactly as before, so no 0.3 client sees a different byte.
 *
 * What a v1.0 client sends and reads was taken from Hermes v0.21.3's client
 * (`plugins/platforms/a2a/{tools,protocol,adapter}.py`) and recorded in
 * docs/sessions/2026-09-20-a2a-v1-wire.md before this file was written.
 *
 * Sources: https://a2a-protocol.org/latest/specification/ (v1.0).
 */

import {
  A2A_ERROR_UNSUPPORTED_OPERATION,
  A2A_TEXT_MEDIA_TYPE,
  type A2AArtifact,
  type A2AJsonRpcError,
  type A2AJsonRpcRequest,
  type A2AMessage,
  type A2AMessageSendParams,
  type A2APart,
  type A2AStreamEvent,
  type A2ATask,
  type A2ATaskState,
  type A2ATaskStatus,
} from "./spec.js";

/** The v1.0 protocol version, as it appears in the card's interface and the request header. */
export const A2A_V1_PROTOCOL_VERSION = "1.0";

/** Spec v1.0 §3.4: the version header a client sends, and this server echoes on a v1.0 answer. */
export const A2A_VERSION_HEADER = "A2A-Version";

/** Which wire dialect a request is in. */
export type A2ADialect = "0.3.0" | "1.0";

/**
 * v1.0 method name -> the 0.3.0 method the lifecycle already answers. `ListTasks` has no 0.3
 * equivalent and is refused below rather than mapped; the push-config and subscribe methods map
 * onto names `rpc.ts` already refuses with the specification's codes.
 */
const V1_METHODS: Readonly<Record<string, string>> = {
  SendMessage: "message/send",
  SendStreamingMessage: "message/stream",
  GetTask: "tasks/get",
  CancelTask: "tasks/cancel",
  SubscribeToTask: "tasks/resubscribe",
  CreateTaskPushNotificationConfig: "tasks/pushNotificationConfig/set",
  GetTaskPushNotificationConfig: "tasks/pushNotificationConfig/get",
  ListTaskPushNotificationConfigs: "tasks/pushNotificationConfig/list",
  DeleteTaskPushNotificationConfig: "tasks/pushNotificationConfig/delete",
  GetExtendedAgentCard: "agent/getAuthenticatedExtendedCard",
};

/** v1.0 methods this agent does not implement at all, with the code the specification gives. */
const V1_UNSUPPORTED: Readonly<Record<string, A2AJsonRpcError>> = {
  ListTasks: { code: A2A_ERROR_UNSUPPORTED_OPERATION, message: "this agent does not list tasks; read one with GetTask" },
};

/** Spec v1.0 `TaskState` <- spec 0.3 `TaskState`. */
const V1_STATE: Readonly<Record<A2ATaskState, string>> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  unknown: "TASK_STATE_UNSPECIFIED",
};

const V1_ROLE: Readonly<Record<A2AMessage["role"], string>> = { user: "ROLE_USER", agent: "ROLE_AGENT" };

/** The dialect a request is in: v1.0 when its method is a v1.0 name, 0.3.0 otherwise. */
export function a2aDialect(request: A2AJsonRpcRequest | undefined): A2ADialect {
  const method = request?.method;
  return typeof method === "string" && (method in V1_METHODS || method in V1_UNSUPPORTED) ? "1.0" : "0.3.0";
}

/** The refusal for a v1.0 method this agent does not implement, or undefined when it does. */
export function v1Unsupported(method: string): A2AJsonRpcError | undefined {
  return V1_UNSUPPORTED[method];
}

/**
 * A v1.0 request as the 0.3.0 request the dispatcher already answers. A 0.3.0 request comes back
 * as itself. The JSON-RPC `id` is untouched: it is the client's, in either dialect.
 */
export function toSpecRequest(request: A2AJsonRpcRequest): A2AJsonRpcRequest {
  if (a2aDialect(request) !== "1.0") return request;
  const method = request.method as string;
  const spec = V1_METHODS[method] ?? method;
  return { ...request, method: spec, params: toSpecParams(spec, request.params) };
}

function toSpecParams(specMethod: string, params: unknown): unknown {
  if (params === undefined || params === null || typeof params !== "object") return params;
  const record = params as Record<string, unknown>;
  switch (specMethod) {
    case "message/send":
    case "message/stream": {
      if (typeof record.message !== "object" || record.message === null) return record;
      // `tenant` (v1.0 multi-tenancy) is not a 0.3 field; it is dropped, never routed on.
      const { tenant: _tenant, ...rest } = record;
      return { ...rest, message: fromV1Message(record.message as Record<string, unknown>) } satisfies A2AMessageSendParams;
    }
    case "tasks/get":
    case "tasks/cancel":
    case "tasks/resubscribe": {
      // v1.0 `GetTaskRequest.id`; `taskId` is tolerated because Hermes's own adapter reads both.
      const id = typeof record.id === "string" ? record.id : typeof record.taskId === "string" ? record.taskId : undefined;
      return id === undefined ? record : { ...record, id };
    }
    default:
      return record;
  }
}

/** A v1.0 `Message` as a 0.3 one. A part that is not text keeps a non-text `kind`, so the lifecycle refuses it. */
export function fromV1Message(message: Record<string, unknown>): A2AMessage {
  const role = message.role === "ROLE_AGENT" || message.role === "agent" ? "agent" : "user";
  const parts = Array.isArray(message.parts) ? message.parts.map((part) => fromV1Part(part)) : message.parts;
  // `kind` is set last so a v1.0 object that carried none gets it and one that did is overwritten.
  return { ...(message as object), role, parts, kind: "message" } as unknown as A2AMessage;
}

function fromV1Part(part: unknown): A2APart | { readonly kind: string } {
  if (part === null || typeof part !== "object") return { kind: "unknown" };
  const record = part as Record<string, unknown>;
  if (typeof record.kind === "string") return record as unknown as A2APart;
  if (typeof record.text === "string") {
    return { kind: "text", text: record.text, ...(record.metadata === undefined ? {} : { metadata: record.metadata as Record<string, unknown> }) };
  }
  if (typeof record.url === "string" || typeof record.raw === "string") return { kind: "file" };
  if ("data" in record) return { kind: "data" };
  return { kind: "unknown" };
}

// --------------------------------------------------------------------------- outbound

/** Spec v1.0 `Part`: member presence, no `kind`. Trent produces text only. */
export function toV1Part(part: A2APart): Record<string, unknown> {
  return { text: part.text, mediaType: A2A_TEXT_MEDIA_TYPE, ...(part.metadata === undefined ? {} : { metadata: part.metadata }) };
}

/** Spec v1.0 `Message`: same fields as 0.3 minus `kind`, with the role enum renamed. */
export function toV1Message(message: A2AMessage): Record<string, unknown> {
  const { kind: _kind, role, parts, ...rest } = message;
  return { ...rest, role: V1_ROLE[role] ?? V1_ROLE.user, parts: parts.map(toV1Part) };
}

function toV1Artifact(artifact: A2AArtifact): Record<string, unknown> {
  return { ...artifact, parts: artifact.parts.map(toV1Part) };
}

function toV1Status(status: A2ATaskStatus): Record<string, unknown> {
  return {
    state: V1_STATE[status.state] ?? V1_STATE.unknown,
    timestamp: status.timestamp,
    ...(status.message === undefined ? {} : { message: toV1Message(status.message) }),
  };
}

/** Spec v1.0 `Task`: the 0.3 task minus `kind`, with every nested enum and part renamed. */
export function toV1Task(task: A2ATask): Record<string, unknown> {
  const { kind: _kind, status, history, artifacts, ...rest } = task;
  return {
    ...rest,
    status: toV1Status(status),
    ...(history === undefined ? {} : { history: history.map(toV1Message) }),
    ...(artifacts === undefined ? {} : { artifacts: artifacts.map(toV1Artifact) }),
  };
}

/**
 * The v1.0 result for a v1.0 method, from the 0.3 result the dispatcher produced. `SendMessage`
 * answers the `SendMessageResponse` oneof; `GetTask` and `CancelTask` answer the bare `Task`.
 */
export function toV1Result(v1Method: string, result: unknown): unknown {
  if (!isTask(result)) return result;
  return v1Method === "SendMessage" ? { task: toV1Task(result) } : toV1Task(result);
}

/** One v1.0 `StreamResponse` frame (a oneof, no `kind`, no `final`) from a 0.3 stream event. */
export function toV1StreamEvent(event: A2AStreamEvent): Record<string, unknown> {
  switch (event.kind) {
    case "task":
      return { task: toV1Task(event) };
    case "message":
      return { message: toV1Message(event) };
    case "status-update": {
      const { kind: _kind, final: _final, status, ...rest } = event;
      return { statusUpdate: { ...rest, status: toV1Status(status) } };
    }
    case "artifact-update": {
      const { kind: _kind, artifact, ...rest } = event;
      return { artifactUpdate: { ...rest, artifact: toV1Artifact(artifact) } };
    }
  }
}

function isTask(value: unknown): value is A2ATask {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "task";
}

// --------------------------------------------------------------------------- errors

/** 0.3.0 method names, longest first so no name is rewritten inside a longer one. */
const SPEC_METHODS: readonly (readonly [spec: string, v1: string])[] = Object.entries(V1_METHODS)
  .map(([v1, spec]) => [spec, v1] as const)
  .sort((a, b) => b[0].length - a[0].length);

/** The lifecycle states a task's refusal names, as `is <state>` (`TaskLifecycle.ts`). */
const SPEC_STATE_PHRASE = new RegExp(`\\bis (${Object.keys(V1_STATE).join("|")})\\b`, "g");

/**
 * A 0.3.0 error as the v1.0 client should read it: the same code (the codes did not change), the
 * same `data`, and a message in which each 0.3.0 method name (`tasks/get`) is the v1.0 name
 * (`GetTask`) and each `TaskState` (`is completed`) is the v1.0 enum (`is TASK_STATE_COMPLETED`).
 * A text naming neither comes back untouched.
 */
export function toV1Error(error: A2AJsonRpcError): A2AJsonRpcError {
  let message = error.message;
  for (const [spec, v1] of SPEC_METHODS) message = message.split(spec).join(v1);
  message = message.replace(SPEC_STATE_PHRASE, (_phrase, state: A2ATaskState) => `is ${V1_STATE[state]}`);
  return message === error.message ? error : { ...error, message };
}
