/**
 * The boundary a session crosses on its way off the machine.
 *
 * The default is the important part: `includeContent` is false. Anything that exports, uploads or
 * traces a session gets structure and metrics and no transcript unless a caller has explicitly and
 * visibly opted in. Even then the content is passed through `redactTranscript` first, so opting in
 * costs you a leak of prose, never a leak of a credential.
 *
 * The on-disk session is untouched by all of this. The user owns their own transcript and must be
 * able to resume it verbatim; redaction belongs at the export boundary, not at rest.
 */

import { redactTranscript } from "./redact.js";
import type { SessionData, SessionMessage } from "../sessions/schema.js";

export interface SessionExportOptions {
  /**
   * Include message bodies in the export. Defaults to FALSE. When true, bodies are still redacted.
   */
  includeContent: boolean;
  /** Include per-message token and cost metrics. Defaults to true; these carry no user text. */
  includeMetrics?: boolean;
  /** Cap on exported messages, newest last. Omit for all. */
  maxMessages?: number;
}

export const DEFAULT_SESSION_EXPORT_OPTIONS: Readonly<SessionExportOptions> = Object.freeze({
  includeContent: false,
  includeMetrics: true,
});

export interface ExportedMessage {
  id: string;
  role: SessionMessage["role"];
  agent?: string;
  timestamp: string;
  /** Always present: a size signal that reveals nothing about the text. */
  contentLength: number;
  /** Names only. Tool arguments and results are payloads and are never exported. */
  toolCallNames?: string[];
  cost_cents?: number;
  durationMs?: number;
  model?: string;
  tokens?: { prompt: number; completion: number; total: number };
  /** Present only when `includeContent` was explicitly true. Redacted. */
  content?: string;
}

export interface ExportedSession {
  schemaVersion: number;
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: string;
  model: string;
  provider: string;
  status: SessionData["status"];
  total_cost_cents: number;
  total_duration_ms: number;
  messageCount: number;
  contentIncluded: boolean;
  messages: ExportedMessage[];
}

function exportMessage(
  message: SessionMessage,
  options: SessionExportOptions,
): ExportedMessage {
  const out: ExportedMessage = {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    contentLength: message.content?.length ?? 0,
  };
  if (message.agent !== undefined) out.agent = message.agent;

  const meta = message.metadata;
  if (meta !== undefined) {
    if (Array.isArray(meta.tool_calls)) {
      out.toolCallNames = meta.tool_calls.map((c) => String(c.name));
    }
    if (options.includeMetrics !== false) {
      if (meta.cost_cents !== undefined) out.cost_cents = meta.cost_cents;
      const duration = meta.duration_ms ?? meta.durationMs;
      if (duration !== undefined) out.durationMs = duration;
      if (meta.model !== undefined) out.model = meta.model;
      if (meta.tokens !== undefined) out.tokens = meta.tokens;
    }
  }

  if (options.includeContent) {
    out.content = redactTranscript(message.content ?? "");
  }

  return out;
}

/**
 * Produce the exportable view of a session. Title is redacted unconditionally because it is
 * auto-generated from the first user message, which is exactly where a pasted key ends up.
 */
export function exportSession(
  session: SessionData,
  options?: Partial<SessionExportOptions>,
): ExportedSession {
  const opts: SessionExportOptions = { ...DEFAULT_SESSION_EXPORT_OPTIONS, ...options };

  const source =
    opts.maxMessages === undefined
      ? session.messages
      : session.messages.slice(-opts.maxMessages);

  return {
    schemaVersion: session.schemaVersion,
    id: session.id,
    title: redactTranscript(session.title),
    created_at: session.created_at,
    updated_at: session.updated_at,
    agent: session.agent,
    model: session.model,
    provider: session.provider,
    status: session.status,
    total_cost_cents: session.total_cost_cents,
    total_duration_ms: session.total_duration_ms,
    messageCount: session.messages.length,
    contentIncluded: opts.includeContent,
    messages: source.map((m) => exportMessage(m, opts)),
  };
}
