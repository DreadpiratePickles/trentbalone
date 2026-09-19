/**
 * The pre-specification transport: `POST /a2a/tasks` with Trent's own payload.
 *
 * It shipped one release before the specification transport existed, and `grep -rn "a2a/tasks"`
 * finds it referenced only by this repository's own tests and docs — no other component depends on
 * it. It is kept for ONE release behind {@link A2A_DEPRECATION_HEADERS} rather than deleted on the
 * day the replacement lands, so anything that did start using it gets a header telling it where to
 * go instead of a 404.
 *
 * There is no second lifecycle behind it: the payload is translated into a spec `Message`, the
 * spec engine runs it, and the spec `Task` is translated back into the old response shape. When
 * the route goes, this file goes with it and nothing else changes.
 */

import { a2aMessageText, type A2AMessageSendParams, type A2ATask, type A2ATaskState, type A2ATaskStatus } from "./spec.js";

/** Trent's pre-specification task payload. */
export interface A2ATaskPayload {
  taskId: string;
  originAgent: string;
  targetAgent: string;
  taskType: string;
  parameters: Record<string, unknown>;
  /** The delegating agent's own words. Preferred over the objective composed from the fields above. */
  objective?: string;
}

/** The pre-specification response shape. Kept verbatim so the route's behaviour does not drift. */
export interface A2ALegacyTask {
  readonly id: string;
  readonly agent: string;
  readonly taskType: string;
  readonly objective: string;
  readonly status: { readonly state: A2ATaskState; readonly timestamp: string };
  readonly history: readonly { readonly state: A2ATaskState; readonly timestamp: string }[];
  readonly artifacts: readonly { readonly name: string; readonly parts: readonly { readonly type: "text"; readonly text: string }[] }[];
  readonly runId?: string;
  readonly error?: string;
}

/** RFC 8594 / RFC 8288: this endpoint is going, and here is the one that replaces it. */
export const A2A_DEPRECATION_HEADERS: Readonly<Record<string, string>> = {
  Deprecation: "true",
  Link: '</.well-known/agent-card.json>; rel="successor-version"',
};

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

/** The old payload as the specification's `message/send` params, with the caller's own task id. */
export function a2aLegacyParams(payload: A2ATaskPayload): A2AMessageSendParams {
  return {
    message: {
      kind: "message",
      role: "user",
      messageId: `legacy-${String(payload.taskId ?? "")}`,
      taskId: String(payload.taskId ?? ""),
      parts: [{ kind: "text", text: a2aObjective(payload) }],
    },
  };
}

/** What the old route stored about the delegation, kept on the spec task's `metadata`. */
export function a2aLegacyMetadata(payload: A2ATaskPayload): Record<string, unknown> {
  return {
    agent: String(payload.targetAgent ?? ""),
    taskType: String(payload.taskType ?? ""),
    originAgent: String(payload.originAgent ?? ""),
    objective: a2aObjective(payload),
  };
}

function plain(status: A2ATaskStatus): { state: A2ATaskState; timestamp: string } {
  return { state: status.state, timestamp: status.timestamp };
}

/** A spec `Task` in the old response shape. `states` is the transition history the old shape had. */
export function a2aLegacyTask(task: A2ATask, states: readonly A2ATaskStatus[]): A2ALegacyTask {
  const metadata = (task.metadata ?? {}) as Record<string, unknown>;
  const reason = a2aMessageText(task.status.message);
  const runId = metadata.runId;
  return {
    id: task.id,
    agent: String(metadata.agent ?? ""),
    taskType: String(metadata.taskType ?? ""),
    objective: String(metadata.objective ?? ""),
    status: plain(task.status),
    history: states.map(plain),
    artifacts: (task.artifacts ?? []).map((artifact) => ({
      name: artifact.name ?? "",
      parts: artifact.parts.map((part) => ({ type: "text" as const, text: part.text })),
    })),
    ...(typeof runId === "string" ? { runId } : {}),
    ...(task.status.state === "completed" || reason === "" ? {} : { error: reason }),
  };
}
