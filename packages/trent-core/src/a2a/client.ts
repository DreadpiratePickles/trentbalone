/**
 * [P2-9] The A2A client: read a peer's Agent Card and send it one message, in the dialect the card
 * advertises. The server half is `A2AServer.ts`; this is the other direction.
 *
 * Transport is a `fetch`-shaped function the caller supplies: in production the egress client
 * (`tools/web/proxied-fetch.ts`), so every request goes through the proxy and its allowlist; in a
 * test, `globalThis.fetch` against a local peer. Nothing here decides WHICH peer may be reached:
 * the `a2a` toolset checks every URL against the configured peers before calling in, and checks the
 * endpoint a card names the same way (`tools/a2a/peers.ts`).
 *
 * The dialects, from the specification's data model (`spec.ts`), its v1.0 renames (`v1.ts`) and
 * Hermes v0.21.3's wire (docs/sessions/2026-09-20-a2a-v1-wire.md):
 *   - v1.0: the card's `supportedInterfaces[]` entry with `protocolBinding: "JSONRPC"` and a 1.x
 *     `protocolVersion` names the endpoint; the call is `SendMessage` with a `ROLE_USER` message whose
 *     parts are `{text, mediaType}` (no `kind`), under `A2A-Version: 1.0`; the result is `{task}` or
 *     `{message}`, states are `TASK_STATE_*`.
 *   - 0.3.0: the card's top-level `url` is the endpoint; the call is `message/send` with a
 *     `kind: "message"`, role `user`, parts `{kind: "text", text}`; the result is a bare `Task`
 *     (`kind: "task"`) or `Message`.
 * A card advertising both is spoken to in v1.0, as Hermes does.
 *
 * The bearer is handed in already resolved; it is written into one header and never into an error,
 * a record or a log. Peer text in a reply is returned as data; the caller tags it untrusted.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { EXIT, TrentError } from "../errors/index.js";
import { A2A_LEGACY_WELL_KNOWN_PATH, A2A_TEXT_MEDIA_TYPE, A2A_TRANSPORT_JSONRPC, A2A_WELL_KNOWN_PATH, type A2ATaskState } from "./spec.js";
import { A2A_V1_PROTOCOL_VERSION, A2A_VERSION_HEADER, type A2ADialect } from "./v1.js";

export type FetchLike = typeof fetch;

/** The longest a peer may take to answer one message: a Trent peer runs a whole orchestration. */
export const A2A_CLIENT_TIMEOUT_MS = 300_000;
/** The largest body read from a peer. */
export const A2A_MAX_BODY_BYTES = 2_000_000;

export type A2AClientErrorKind = "card" | "http" | "rpc" | "refused" | "transport" | "reply";

export class A2AClientError extends TrentError {
  readonly kind: A2AClientErrorKind;
  readonly status?: number;
  readonly rpcCode?: number;

  constructor(kind: A2AClientErrorKind, operation: string, message: string, target: string, detail: { status?: number; rpcCode?: number; cause?: unknown } = {}) {
    super({ code: kind === "refused" ? EXIT.CONFIG : EXIT.PROVIDER, operation, message, target, ...(detail.cause === undefined ? {} : { cause: detail.cause }) });
    this.name = "A2AClientError";
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.rpcCode !== undefined) this.rpcCode = detail.rpcCode;
  }
}

export interface A2AClientOptions {
  readonly fetchImpl: FetchLike;
  /** The peer's bearer, already resolved by name. Sent on JSON-RPC calls only; the card is public. */
  readonly token?: string;
  /** Headers every request carries (the egress own-credential marker). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface A2APeerSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
}

/** A card as the client uses it: validated, with the endpoint and dialect it will speak. */
export interface A2APeerCard {
  readonly cardUrl: string;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly dialect: A2ADialect;
  readonly endpoint: string;
  /** Every JSON-RPC endpoint the card advertises, per dialect. */
  readonly interfaces: readonly { readonly dialect: A2ADialect; readonly url: string }[];
  readonly skills: readonly A2APeerSkill[];
  /** The card declares `security`: the endpoint expects a credential. */
  readonly requiresAuth: boolean;
  readonly streaming: boolean;
}

export interface A2ASendInput {
  readonly endpoint: string;
  readonly dialect: A2ADialect;
  readonly text: string;
  readonly taskId?: string;
  readonly contextId?: string;
  /** Stable across a replay of the same call, so a peer that dedupes by it sees one message. */
  readonly messageId?: string;
}

/** One answer, normalised to the 0.3.0 state names whatever the dialect. */
export interface A2AReply {
  readonly taskId?: string;
  readonly contextId?: string;
  readonly state: A2ATaskState;
  /** The first artifact's text, else the status message's, else the message's own. */
  readonly text: string;
  /** Present when the task waits for the caller: the peer's question. */
  readonly question?: string;
}

const PartSchema = z.object({ text: z.string().optional(), kind: z.string().optional() }).passthrough();
const InterfaceSchema = z.object({ url: z.string(), protocolBinding: z.string(), protocolVersion: z.string() }).passthrough();
const SkillSchema = z.object({ id: z.string(), name: z.string(), description: z.string().default(""), tags: z.array(z.string()).default([]) }).passthrough();
const CardSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().default(""),
    version: z.string().optional(),
    url: z.string().optional(),
    protocolVersion: z.string().optional(),
    preferredTransport: z.string().optional(),
    supportedInterfaces: z.array(InterfaceSchema).optional(),
    skills: z.array(SkillSchema).default([]),
    capabilities: z.object({ streaming: z.boolean().optional() }).passthrough().default({}),
    security: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** The JSON-RPC endpoints a card advertises, v1.0 first. */
function interfacesOf(card: z.infer<typeof CardSchema>): { dialect: A2ADialect; url: string }[] {
  const out: { dialect: A2ADialect; url: string }[] = [];
  for (const entry of card.supportedInterfaces ?? []) {
    if (entry.protocolBinding.toUpperCase() !== A2A_TRANSPORT_JSONRPC || !isHttpUrl(entry.url)) continue;
    if (entry.protocolVersion.startsWith("1.")) out.push({ dialect: "1.0", url: entry.url });
    else if (entry.protocolVersion.startsWith("0.3")) out.push({ dialect: "0.3.0", url: entry.url });
  }
  const legacyTransport = card.preferredTransport === undefined || card.preferredTransport.toUpperCase() === A2A_TRANSPORT_JSONRPC;
  const legacyVersion = card.protocolVersion === undefined || card.protocolVersion.startsWith("0.");
  if (card.url !== undefined && isHttpUrl(card.url) && legacyTransport && legacyVersion && !out.some((entry) => entry.dialect === "0.3.0")) {
    out.push({ dialect: "0.3.0", url: card.url });
  }
  return out.sort((a, b) => (a.dialect === b.dialect ? 0 : a.dialect === "1.0" ? -1 : 1));
}

/** Validates a card and picks the endpoint this client will speak to. Throws a `card` error. */
export function parseAgentCard(raw: unknown, cardUrl: string): A2APeerCard {
  const parsed = CardSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].join(", ");
    throw new A2AClientError("card", "a2a.card", `the agent card is not valid: ${fields}`, cardUrl);
  }
  const card = parsed.data;
  const interfaces = interfacesOf(card);
  const chosen = interfaces[0];
  if (chosen === undefined) {
    throw new A2AClientError("card", "a2a.card", "the agent card advertises no JSON-RPC endpoint this client speaks (a v1.0 JSONRPC interface or a 0.3 url)", cardUrl);
  }
  return {
    cardUrl,
    name: card.name,
    description: card.description,
    ...(card.version === undefined ? {} : { version: card.version }),
    dialect: chosen.dialect,
    endpoint: chosen.url,
    interfaces,
    skills: card.skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description, tags: [...skill.tags] })),
    requiresAuth: (card.security ?? []).length > 0,
    streaming: card.capabilities.streaming === true,
  };
}

/** The Trent egress proxy's own refusal, recognised so the caller can name the allowlist. */
function egressRefusal(body: unknown): string | undefined {
  const record = body as { error?: unknown; reason?: unknown } | null;
  return record !== null && typeof record === "object" && record.error === "egress_refused" ? String(record.reason ?? "refused") : undefined;
}

async function request(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }, options: A2AClientOptions, operation: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? A2A_CLIENT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await options.fetchImpl(url, { ...init, headers: { ...(options.headers ?? {}), ...init.headers }, redirect: "error", signal: controller.signal });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const detail = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
    const kind = name === "EgressRefusedError" ? "refused" : "transport";
    throw new A2AClientError(kind, operation, kind === "refused" ? `the egress proxy refused the host: ${detail}` : `the request did not complete: ${detail}`, url, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > A2A_MAX_BODY_BYTES) throw new A2AClientError("reply", operation, `the peer answered more than ${A2A_MAX_BODY_BYTES} bytes`, url, { status: response.status });
  let body: unknown = undefined;
  try {
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  const refused = egressRefusal(body);
  if (refused !== undefined) throw new A2AClientError("refused", operation, `the egress proxy refused the host (${refused})`, new URL(url).host, { status: response.status });
  return { status: response.status, body };
}

/**
 * Fetches and validates the card for `baseUrl`: the well-known path at that origin, then the
 * pre-0.3 one when the first answers 404. A URL that already names a `.json` path is read as is.
 */
export async function fetchAgentCard(baseUrl: string, options: A2AClientOptions): Promise<A2APeerCard> {
  const base = new URL(baseUrl);
  const candidates = base.pathname.endsWith(".json") ? [base.toString()] : [new URL(A2A_WELL_KNOWN_PATH, base).toString(), new URL(A2A_LEGACY_WELL_KNOWN_PATH, base).toString()];
  for (const [index, cardUrl] of candidates.entries()) {
    const { status, body } = await request(cardUrl, { method: "GET", headers: { accept: "application/json" } }, options, "a2a.discover");
    if (status === 404 && index < candidates.length - 1) continue;
    if (status < 200 || status >= 300) throw new A2AClientError("http", "a2a.discover", `the peer answered HTTP ${status} for its agent card`, cardUrl, { status });
    return parseAgentCard(body, cardUrl);
  }
  throw new A2AClientError("http", "a2a.discover", "the peer serves no agent card at either well-known path", base.origin, { status: 404 });
}

/** The JSON-RPC request body for one message, in `dialect`. Pure; the ids are the caller's. */
export function a2aSendBody(input: A2ASendInput, requestId: string, messageId: string): Record<string, unknown> {
  const ids = { ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.contextId === undefined ? {} : { contextId: input.contextId }) };
  if (input.dialect === "1.0") {
    const message = { role: "ROLE_USER", parts: [{ text: input.text, mediaType: A2A_TEXT_MEDIA_TYPE }], messageId, ...ids };
    return { jsonrpc: "2.0", id: requestId, method: "SendMessage", params: { message } };
  }
  const message = { kind: "message", role: "user", parts: [{ kind: "text", text: input.text }], messageId, ...ids };
  return { jsonrpc: "2.0", id: requestId, method: "message/send", params: { message } };
}

const STATES: ReadonlySet<string> = new Set<A2ATaskState>(["submitted", "working", "input-required", "completed", "canceled", "failed", "rejected", "auth-required", "unknown"]);

/** `TASK_STATE_INPUT_REQUIRED` and `input-required` both read as `input-required`. */
export function normaliseState(raw: unknown): A2ATaskState {
  if (typeof raw !== "string") return "unknown";
  const state = raw.replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");
  if (state === "unspecified") return "unknown";
  if (state === "cancelled") return "canceled";
  return STATES.has(state) ? (state as A2ATaskState) : "unknown";
}

function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => PartSchema.safeParse(part))
    .filter((result) => result.success && typeof result.data.text === "string" && (result.data.kind === undefined || result.data.kind === "text"))
    .map((result) => (result.success ? result.data.text ?? "" : ""))
    .join("\n")
    .trim();
}

function field(record: unknown, key: string): unknown {
  return record !== null && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
}

/** The reply in one shape from either dialect's result: `{task}`, `{message}`, a bare Task or a bare Message. */
export function parseSendResult(result: unknown): A2AReply {
  const payload = field(result, "task") ?? field(result, "message") ?? result;
  if (payload === null || typeof payload !== "object") throw new A2AClientError("reply", "a2a.send", "the peer's result carries neither a task nor a message", "result");
  const status = field(payload, "status");
  const isTask = field(payload, "kind") === "task" || status !== undefined;
  const taskId = isTask ? field(payload, "id") : field(payload, "taskId");
  const contextId = field(payload, "contextId");
  const state = isTask ? normaliseState(field(status, "state")) : "completed";
  const artifacts = field(payload, "artifacts");
  const artifactText = Array.isArray(artifacts) ? artifacts.map((artifact) => textOf(field(artifact, "parts"))).find((text) => text !== "") ?? "" : "";
  const statusText = textOf(field(field(status, "message"), "parts"));
  const ownText = isTask ? "" : textOf(field(payload, "parts"));
  const text = artifactText || statusText || ownText;
  const waiting = state === "input-required" || state === "auth-required";
  return {
    ...(typeof taskId === "string" && taskId !== "" ? { taskId } : {}),
    ...(typeof contextId === "string" && contextId !== "" ? { contextId } : {}),
    state,
    text,
    ...(waiting && statusText !== "" ? { question: statusText } : {}),
  };
}

/** Sends one message and returns the peer's answer. Throws `http`, `rpc`, `refused`, `transport` or `reply`. */
export async function sendA2AMessage(input: A2ASendInput, options: A2AClientOptions): Promise<A2AReply> {
  const body = a2aSendBody(input, `trent-${crypto.randomUUID()}`, input.messageId ?? crypto.randomUUID());
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (input.dialect === "1.0") headers[A2A_VERSION_HEADER] = A2A_V1_PROTOCOL_VERSION;
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const { status, body: answer } = await request(input.endpoint, { method: "POST", headers, body: JSON.stringify(body) }, options, "a2a.send");
  if (status === 401 || status === 403) {
    throw new A2AClientError("http", "a2a.send", `the peer refused the credential (HTTP ${status})${options.token === undefined ? "; it expects a bearer and none is configured" : ""}`, input.endpoint, { status });
  }
  if (status < 200 || status >= 300) throw new A2AClientError("http", "a2a.send", `the peer answered HTTP ${status}`, input.endpoint, { status });
  const error = field(answer, "error");
  if (error !== undefined) {
    const code = field(error, "code");
    const message = field(error, "message");
    throw new A2AClientError("rpc", "a2a.send", `the peer returned JSON-RPC error ${String(code)}: ${typeof message === "string" ? message.slice(0, 300) : "no message"}`, input.endpoint, { ...(typeof code === "number" ? { rpcCode: code } : {}) });
  }
  if (field(answer, "result") === undefined) throw new A2AClientError("reply", "a2a.send", "the peer's answer is not a JSON-RPC result", input.endpoint, { status });
  return parseSendResult(field(answer, "result"));
}
