/**
 * The A2A specification's own data model, as TypeScript. No transport, no behaviour.
 *
 * Every name and every literal below is taken from the published specification and the JSON Schema
 * it is generated from, not from anything Trent invented:
 *
 *   https://a2a-protocol.org/latest/specification/
 *   https://github.com/a2aproject/A2A/blob/v0.3.0/specification/json/a2a.json
 *
 * The point of this file is that a client written against that document — and nothing else — can
 * talk to Trent. Where the schema says `kind`, this says `kind`; where it says `artifactId`, this
 * says `artifactId`. Trent's own vocabulary (seat, objective, run) appears only inside `metadata`,
 * which the specification reserves for exactly that.
 */

/** Spec §6.3 `TaskState`. The full enum, including the states this server never enters. */
export type A2ATaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "auth-required"
  | "unknown";

/** The states a task can never leave. `tasks/cancel` on one of these is `TaskNotCancelableError`. */
export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set<A2ATaskState>([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

/** Spec §6.5.1 `TextPart`. Trent produces and accepts text only; see `docs/a2a.md`. */
export interface A2ATextPart {
  readonly kind: "text";
  readonly text: string;
  readonly metadata?: Record<string, unknown>;
}

/** Spec §6.5 `Part`. Only the text variant is implemented; a file or data part is refused. */
export type A2APart = A2ATextPart;

/** Spec §6.4 `Message`. */
export interface A2AMessage {
  readonly kind: "message";
  readonly messageId: string;
  readonly role: "user" | "agent";
  readonly parts: readonly A2APart[];
  readonly contextId?: string;
  readonly taskId?: string;
  readonly referenceTaskIds?: readonly string[];
  readonly extensions?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** Spec §6.6 `Artifact`. */
export interface A2AArtifact {
  readonly artifactId: string;
  readonly parts: readonly A2APart[];
  readonly name?: string;
  readonly description?: string;
  readonly extensions?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

/** Spec §6.2 `TaskStatus`. `message` carries the agent's side of an interrupted state. */
export interface A2ATaskStatus {
  readonly state: A2ATaskState;
  readonly timestamp: string;
  readonly message?: A2AMessage;
}

/** Spec §6.1 `Task`. */
export interface A2ATask {
  readonly kind: "task";
  readonly id: string;
  readonly contextId: string;
  readonly status: A2ATaskStatus;
  readonly history?: readonly A2AMessage[];
  readonly artifacts?: readonly A2AArtifact[];
  readonly metadata?: Record<string, unknown>;
}

/** Spec §7.2.1 `TaskStatusUpdateEvent`. */
export interface A2ATaskStatusUpdateEvent {
  readonly kind: "status-update";
  readonly taskId: string;
  readonly contextId: string;
  readonly status: A2ATaskStatus;
  readonly final: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** Spec §7.2.2 `TaskArtifactUpdateEvent`. */
export interface A2ATaskArtifactUpdateEvent {
  readonly kind: "artifact-update";
  readonly taskId: string;
  readonly contextId: string;
  readonly artifact: A2AArtifact;
  readonly append?: boolean;
  readonly lastChunk?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** Spec §7.2 — what one `message/stream` SSE frame carries in its JSON-RPC `result`. */
export type A2AStreamEvent = A2ATask | A2AMessage | A2ATaskStatusUpdateEvent | A2ATaskArtifactUpdateEvent;

/** Spec §7.1 `MessageSendParams`. `configuration` is accepted and ignored; see `docs/a2a.md`. */
export interface A2AMessageSendParams {
  readonly message: A2AMessage;
  readonly configuration?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

/** Spec §7.3 `TaskQueryParams`. */
export interface A2ATaskQueryParams {
  readonly id: string;
  readonly historyLength?: number;
  readonly metadata?: Record<string, unknown>;
}

/** Spec §7.4 `TaskIdParams`. */
export interface A2ATaskIdParams {
  readonly id: string;
  readonly metadata?: Record<string, unknown>;
}

// --------------------------------------------------------------------------- agent card

/** Spec §5.5.4 `AgentCapabilities`. `extendedAgentCard` is v1.0's name for the extended card flag. */
export interface A2AAgentCapabilities {
  readonly streaming?: boolean;
  readonly pushNotifications?: boolean;
  readonly stateTransitionHistory?: boolean;
  readonly extendedAgentCard?: boolean;
}

/**
 * Spec v1.0 `AgentInterface`: one endpoint, one binding, one protocol version. v1.0 clients read
 * `supportedInterfaces` before the 0.3 top-level `url`; the card carries both, and both are true.
 */
export interface A2AAgentInterface {
  readonly url: string;
  readonly protocolBinding: string;
  readonly protocolVersion: string;
  readonly tenant?: string;
}

/** Spec §5.5.6 `AgentSkill`. */
export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples?: readonly string[];
  readonly inputModes?: readonly string[];
  readonly outputModes?: readonly string[];
}

/** Spec §5.5.3 `AgentProvider`. */
export interface A2AAgentProvider {
  readonly organization: string;
  readonly url: string;
}

/** Spec §5.5.1 `AgentCard`. The object served at {@link A2A_WELL_KNOWN_PATH}. */
export interface A2AAgentCard {
  readonly protocolVersion: string;
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly preferredTransport: string;
  readonly version: string;
  readonly capabilities: A2AAgentCapabilities;
  readonly defaultInputModes: readonly string[];
  readonly defaultOutputModes: readonly string[];
  readonly skills: readonly A2AAgentSkill[];
  readonly provider?: A2AAgentProvider;
  readonly documentationUrl?: string;
  readonly securitySchemes?: Record<string, unknown>;
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly supportsAuthenticatedExtendedCard?: boolean;
  /** v1.0 discovery. Present only when the endpoint answers the v1.0 method names (`./v1.ts`). */
  readonly supportedInterfaces?: readonly A2AAgentInterface[];
}

/**
 * Spec §5.5 / §8.2 — where a client looks for the card. `/.well-known/agent.json` was the path
 * before 0.3; both are served, because a client pinned to the old one is not a client to break.
 */
export const A2A_WELL_KNOWN_PATH = "/.well-known/agent-card.json";
export const A2A_LEGACY_WELL_KNOWN_PATH = "/.well-known/agent.json";

/** The specification version this server implements, as it appears in the card. */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Spec §5.6.2 — the transport identifier for JSON-RPC 2.0 over HTTP. */
export const A2A_TRANSPORT_JSONRPC = "JSONRPC";

/** The media type a text part carries, and therefore the card's default input and output mode. */
export const A2A_TEXT_MEDIA_TYPE = "text/plain";

// --------------------------------------------------------------------------- errors

/** JSON-RPC 2.0's own codes, unchanged by A2A. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** Spec §8.2 — the A2A-specific codes, in JSON-RPC's reserved server range. */
export const A2A_ERROR_TASK_NOT_FOUND = -32001;
export const A2A_ERROR_TASK_NOT_CANCELABLE = -32002;
export const A2A_ERROR_PUSH_NOT_SUPPORTED = -32003;
export const A2A_ERROR_UNSUPPORTED_OPERATION = -32004;
export const A2A_ERROR_CONTENT_TYPE_NOT_SUPPORTED = -32005;

/**
 * Spec §8.2 allows a server its own codes in `-32000..-32099` provided it documents them. This one
 * means the process was started with no agent runtime, so no task can run here at all — the state
 * the old server answered with a fabricated `completed` (AGENTS.md invariant 2).
 */
export const A2A_ERROR_NO_RUNTIME = -32010;

export interface A2AJsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A JSON-RPC envelope, as the transport writes it. */
export interface A2AJsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: A2AJsonRpcError;
}

export interface A2AJsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

/** The whole text of a message, in part order. Empty when the message carried no text. */
export function a2aMessageText(message: A2AMessage | undefined): string {
  if (message === undefined) return "";
  return message.parts
    .filter((part): part is A2ATextPart => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** One agent-side text message, which is how every interrupted or failed state states its reason. */
export function a2aAgentMessage(id: string, taskId: string, contextId: string, text: string): A2AMessage {
  return { kind: "message", messageId: id, role: "agent", taskId, contextId, parts: [{ kind: "text", text }] };
}
