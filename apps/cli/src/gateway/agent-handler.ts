/**
 * The gateway's agent handler: an inbound chat message that passed the pairing gate becomes one
 * orchestrated run on the headless runtime, and the reply is that run's own consolidated summary.
 *
 * Nothing here composes text. The summary comes off the event stream (`consolidate_end` and
 * `run_done` carry `run.summary`; the wrapper's consolidator stamps the real brief on both), a
 * failed run replies with the reason the `run_failed` frame carries, and a stream that ends with
 * neither is silence — the manager sends nothing for `null`. Approval gates on the run are not
 * handled here: the approval link rides on the runtime's bus hooks and sees every run.
 *
 * A chat thread is one session. The gateway store maps `platform:chat:thread` to a session id;
 * the first message on a thread creates the session, every later one resumes it, and each turn
 * (the user's text, then the reply) is appended to that session's transcript exactly as the TUI
 * appends its own turns. `/new` forgets the mapping so the next message starts a fresh session.
 */

import path from "node:path";
import { ConfigManager, SessionManager } from "@trent/core";
import {
  FileGatewayStore,
  clearConversationSession,
  conversationKey,
  getConversationSession,
  setConversationSession,
  type AgentHandler,
  type GatewayStore,
  type InboundMessage,
} from "@trent/core/gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import {
  DEFAULT_HISTORY_CHARS,
  DEFAULT_HISTORY_TURNS,
  trimHistory,
  type HistoryMessage,
} from "../repl/conversation.js";
import type { HeadlessRuntime } from "../runtime/headless.js";

/** What the handler needs of the runtime: one run per message. */
export type AgentRuntime = Pick<HeadlessRuntime, "run">;

/** The message text that rotates a thread's session. Nothing else is interpreted here. */
export const NEW_SESSION_COMMAND = "/new";

/**
 * Where the thread-to-session map and the transcripts live. Defaults are the profile's own
 * `gateway.json` (the same file the manager keeps its rows in; every mutation re-reads it, so
 * two instances over one file do not clobber each other) and the profile's sessions directory.
 */
export interface AgentHandlerDeps {
  readonly configManager?: ConfigManager;
  readonly store?: GatewayStore;
  readonly sessions?: SessionManager;
}

/** The reply a finished stream produces, folded one event at a time. */
export function replyFromEvent(current: string | null, event: OrcEvent): string | null {
  switch (event.kind) {
    case "consolidate_end":
    case "run_done": {
      const summary = event.run?.summary;
      return summary !== undefined && summary !== "" ? summary : current;
    }
    case "run_failed": {
      if (event.detail !== undefined && event.detail !== "") return `Run failed: ${event.detail}`;
      const summary = event.run?.summary;
      return summary !== undefined && summary !== "" ? summary : current;
    }
    default:
      return current;
  }
}

/** The session this thread runs in: the mapped one when it still exists, else a new one, mapped. */
export function resolveThreadSession(
  store: GatewayStore,
  sessions: SessionManager,
  message: Pick<InboundMessage, "platform" | "channelId" | "threadId">,
  agentId: string,
  model: { provider: string; model: string },
): string {
  const key = conversationKey(message);
  const mapped = getConversationSession(store, key);
  if (mapped !== undefined && sessions.getSession(mapped) !== null) return mapped;
  const session = sessions.startSession(agentId, model.model, model.provider);
  setConversationSession(store, key, session.id);
  return session.id;
}

/**
 * The turns this thread has already had, bounded exactly as the REPL bounds its own. An assistant
 * message the user interrupted is in the transcript but is not re-threaded: it was never a reply.
 */
export function threadHistory(session: { messages: readonly SessionMessageLike[] } | null): HistoryMessage[] {
  const messages = (session?.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.metadata?.status !== "interrupted")
    .map((m) => ({ role: m.role as HistoryMessage["role"], content: m.content }));
  return trimHistory(messages, { maxTurns: DEFAULT_HISTORY_TURNS, maxChars: DEFAULT_HISTORY_CHARS });
}

/** The slice of a stored message the history reads; `SessionMessage` satisfies it structurally. */
interface SessionMessageLike {
  readonly role: string;
  readonly content: string;
  readonly metadata?: { readonly status?: string };
}

export function createAgentHandler(runtime: AgentRuntime, deps: AgentHandlerDeps = {}): AgentHandler {
  const configManager = deps.configManager ?? new ConfigManager();
  const store = deps.store ?? new FileGatewayStore(path.join(configManager.getProfileDir(), "gateway.json"));
  const sessions = deps.sessions ?? new SessionManager(configManager);

  return async (agentId, message, signal) => {
    if (message.content.trim() === NEW_SESSION_COMMAND) {
      clearConversationSession(store, conversationKey(message));
      return null;
    }
    const config = configManager.loadConfig();
    const sessionId = resolveThreadSession(store, sessions, message, agentId, {
      provider: config.provider,
      model: config.model,
    });
    // The thread's earlier turns, read BEFORE this message joins them, so the run sees the
    // conversation and not its own new line twice. The objective stays the raw message text.
    const history = threadHistory(sessions.getSession(sessionId));
    sessions.appendMessage(sessionId, { role: "user", content: message.content });

    let reply: string | null = null;
    for await (const event of runtime.run(message.content, { trigger: "manual", signal, history })) {
      reply = replyFromEvent(reply, event);
    }
    if (reply !== null) sessions.appendMessage(sessionId, { role: "assistant", agent: agentId, content: reply });
    return reply;
  };
}
