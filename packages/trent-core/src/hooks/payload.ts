/**
 * The JSON document a hook reads on stdin.
 *
 * A hook is a process the user chose, but it is still a process that did not need the secret a
 * tool argument happened to carry: a `terminal` command with an `Authorization: Bearer ...`
 * header, an env assignment, a connection string. Every string in the document — keys included —
 * goes through the repository's one redactor (`telemetry/redact.ts`), which is the same
 * definition the OTel exporter and the session export use. Redaction walks the structure rather
 * than the serialised text, so a placeholder can never break the JSON a hook is about to parse.
 *
 * The shape survives redaction: a hook can still see which tool ran, under which run and seat,
 * and (for a post hook) what the call returned.
 */
import { redactTranscript } from "../telemetry/redact.js";
import type { HookKind, HookToolCall } from "./types.js";

export const HOOK_PAYLOAD_VERSION = 1;

export interface HookPayload {
  readonly hook: HookKind;
  readonly version: number;
  readonly adapter?: string;
  readonly tool?: string;
  readonly arguments?: unknown;
  readonly result?: { readonly status: string; readonly summary: string };
  readonly run_id?: string;
  readonly step_id?: string;
  readonly seat?: string;
  readonly session_id?: string;
}

/** Depth cap: a hook argument bag is data from a model, so it is not trusted to be shallow. */
const MAX_DEPTH = 6;
const MAX_ARRAY = 200;

export function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactTranscript(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redactDeep(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[redactTranscript(key)] = redactDeep(item, depth + 1);
    }
    return out;
  }
  // Functions, symbols and undefined have no place on a hook's stdin.
  return null;
}

function defined<T extends Record<string, unknown>>(entries: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out as T;
}

export function toolPayload(kind: HookKind, call: HookToolCall, result?: { status: string; summary: string }): HookPayload {
  return defined({
    hook: kind,
    version: HOOK_PAYLOAD_VERSION,
    adapter: call.adapter,
    tool: call.tool,
    arguments: redactDeep(call.args),
    run_id: call.runId,
    step_id: call.stepId,
    seat: call.seat,
    result: result === undefined ? undefined : { status: result.status, summary: redactTranscript(result.summary) },
  }) as HookPayload;
}

export function sessionPayload(kind: HookKind, context: { runId?: string; seat?: string; sessionId?: string }): HookPayload {
  return defined({
    hook: kind,
    version: HOOK_PAYLOAD_VERSION,
    run_id: context.runId,
    seat: context.seat,
    session_id: context.sessionId,
  }) as HookPayload;
}
