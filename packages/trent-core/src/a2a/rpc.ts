/**
 * The A2A JSON-RPC 2.0 method surface, with NO transport in it (spec §7).
 *
 * Every method the specification defines is answered here or refused with the code the
 * specification gives for refusing it. A method Trent does not implement gets
 * `UnsupportedOperationError` rather than silence, because a client that asked for push
 * notifications needs to know they will never arrive.
 *
 * Source: https://a2a-protocol.org/latest/specification/
 */

import type { A2ATaskEngine, A2ATaskOutcome } from "./TaskLifecycle.js";
import {
  A2A_ERROR_PUSH_NOT_SUPPORTED,
  A2A_ERROR_TASK_NOT_FOUND,
  A2A_ERROR_UNSUPPORTED_OPERATION,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  type A2AJsonRpcError,
  type A2AJsonRpcRequest,
  type A2AJsonRpcResponse,
  type A2AMessageSendParams,
  type A2ATask,
} from "./spec.js";

/** The streaming method, which a transport has to handle itself. */
export const A2A_STREAM_METHOD = "message/stream";

/** Methods the specification defines that this agent does not implement, and why. */
const UNSUPPORTED: Readonly<Record<string, A2AJsonRpcError>> = {
  "tasks/resubscribe": { code: A2A_ERROR_UNSUPPORTED_OPERATION, message: "this agent does not re-attach a client to a stream it dropped" },
  "tasks/pushNotificationConfig/set": { code: A2A_ERROR_PUSH_NOT_SUPPORTED, message: "this agent sends no push notifications" },
  "tasks/pushNotificationConfig/get": { code: A2A_ERROR_PUSH_NOT_SUPPORTED, message: "this agent sends no push notifications" },
  "tasks/pushNotificationConfig/list": { code: A2A_ERROR_PUSH_NOT_SUPPORTED, message: "this agent sends no push notifications" },
  "tasks/pushNotificationConfig/delete": { code: A2A_ERROR_PUSH_NOT_SUPPORTED, message: "this agent sends no push notifications" },
  "agent/getAuthenticatedExtendedCard": {
    code: A2A_ERROR_UNSUPPORTED_OPERATION,
    message: "this agent publishes one card, at the well-known URI",
  },
};

export function jsonRpcResult(id: string | number | null, result: unknown): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: string | number | null, error: A2AJsonRpcError): A2AJsonRpcResponse {
  return { jsonrpc: "2.0", id, error };
}

/** The envelope's id, or null when the request carried none (JSON-RPC §5). */
export function requestId(request: A2AJsonRpcRequest | undefined): string | number | null {
  const id = request?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** JSON-RPC envelope validation, before any A2A meaning is read from it. */
export function invalidRequest(request: A2AJsonRpcRequest | undefined): A2AJsonRpcError | undefined {
  if (request === undefined || typeof request !== "object") {
    return { code: JSONRPC_INVALID_REQUEST, message: "the request body is not a JSON-RPC object" };
  }
  if (request.jsonrpc !== "2.0") return { code: JSONRPC_INVALID_REQUEST, message: '"jsonrpc" must be "2.0"' };
  if (typeof request.method !== "string" || request.method === "") {
    return { code: JSONRPC_INVALID_REQUEST, message: '"method" must be a non-empty string' };
  }
  return undefined;
}

function outcomeResponse(id: string | number | null, outcome: A2ATaskOutcome): A2AJsonRpcResponse {
  return outcome.ok ? jsonRpcResult(id, outcome.task) : jsonRpcError(id, outcome.error);
}

function taskIdOf(params: unknown): string | undefined {
  const id = (params as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Begin a streaming task. The transport gets the first frame — the `Task` itself, exactly as the
 * specification's streaming example opens — or the error to answer with instead of a stream.
 */
export function beginStream(
  engine: A2ATaskEngine,
  request: A2AJsonRpcRequest,
): { readonly ok: true; readonly task: A2ATask } | { readonly ok: false; readonly response: A2AJsonRpcResponse } {
  const outcome = engine.begin(request.params as A2AMessageSendParams | undefined);
  return outcome.ok ? { ok: true, task: outcome.task } : { ok: false, response: jsonRpcError(requestId(request), outcome.error) };
}

/** Answer one non-streaming request. `message/stream` never reaches here; the transport owns it. */
export async function dispatchA2A(engine: A2ATaskEngine, request: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse> {
  const id = requestId(request);
  const envelope = invalidRequest(request);
  if (envelope !== undefined) return jsonRpcError(id, envelope);

  const method = request.method as string;
  const unsupported = UNSUPPORTED[method];
  if (unsupported !== undefined) return jsonRpcError(id, unsupported);

  switch (method) {
    case "message/send": {
      const begun = engine.begin(request.params as A2AMessageSendParams | undefined);
      if (!begun.ok) return jsonRpcError(id, begun.error);
      return outcomeResponse(id, await engine.run(begun.task.id));
    }
    case "tasks/get": {
      const taskId = taskIdOf(request.params);
      if (taskId === undefined) return jsonRpcError(id, { code: JSONRPC_INVALID_PARAMS, message: 'tasks/get requires a string "id"' });
      const historyLength = (request.params as { historyLength?: unknown }).historyLength;
      const task = engine.get(taskId, typeof historyLength === "number" ? historyLength : undefined);
      if (task === undefined) {
        return jsonRpcError(id, { code: A2A_ERROR_TASK_NOT_FOUND, message: `no task with id "${taskId}" exists here` });
      }
      return jsonRpcResult(id, task);
    }
    case "tasks/cancel": {
      const taskId = taskIdOf(request.params);
      if (taskId === undefined) return jsonRpcError(id, { code: JSONRPC_INVALID_PARAMS, message: 'tasks/cancel requires a string "id"' });
      return outcomeResponse(id, engine.cancel(taskId));
    }
    default:
      return jsonRpcError(id, { code: JSONRPC_METHOD_NOT_FOUND, message: `no method "${method}" on this agent` });
  }
}
