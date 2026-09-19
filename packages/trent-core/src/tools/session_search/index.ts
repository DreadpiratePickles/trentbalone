/**
 * A3 — the `session_search` tool.
 *
 * A seat's own past is the cheapest context it has and it had no way to read it: the transcripts
 * sit at mode 0600 under the profile and compaction is actively shortening what is in the prompt.
 * This is the read path (`sessions/search.ts` ranks; `store/session-fts.ts` indexes), scoped to
 * THIS profile's sessions directory and nothing else.
 */
import path from "node:path";
import { searchSessions, SESSION_SEARCH_DEFAULT_LIMIT, SESSION_SEARCH_MAX_LIMIT, type SessionSearchHit } from "../../sessions/search.js";
import { SessionStore } from "../../sessions/SessionStore.js";
import { intArg, parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";

export const SESSION_SEARCH_ADAPTER_NAME = "session_search";
export const SESSION_SEARCH_SCOPES = ["session_search"];

const SPECS: readonly ToolSpec[] = [{ name: SESSION_SEARCH_ADAPTER_NAME, primary: "query", signature: ["query"] }];
const ROUTING_TEXT =
  "search past sessions, what did we decide last week, find the earlier conversation, look up a " +
  "previous transcript, when did we discuss this, recall an old answer";

export const SESSION_SEARCH_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: SESSION_SEARCH_ADAPTER_NAME,
    description:
      "Full-text search over this profile's past session transcripts. Returns the session id, the " +
      "message index, its timestamp and a snippet, best match first. Read-only; never needs approval. " +
      "Use it before asking the founder something they may already have answered.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The words you expect the transcript to contain." },
        session_id: { type: "string", description: "Search inside one session only." },
        limit: { type: "integer", description: `Maximum rows (1-${SESSION_SEARCH_MAX_LIMIT}, default ${SESSION_SEARCH_DEFAULT_LIMIT}).` },
      },
      required: ["query"],
    },
  },
];

export interface SessionSearchAdapterOptions {
  readonly profileDir: string;
  /** Overrides `<profileDir>/sessions`; the CLI and the tests pass their own. */
  readonly sessionsDir?: string;
}

export function renderHits(query: string, backend: string, hits: readonly SessionSearchHit[]): string {
  if (hits.length === 0) return `no session mentions "${query}".`;
  const lines = hits.map((hit) => `${hit.sessionId} #${hit.messageIndex} ${hit.timestamp} [${hit.role}] ${hit.snippet}`);
  return [`${hits.length} match(es) for "${query}" (${backend}):`, ...lines].join("\n");
}

export function createSessionSearchAdapter(options: SessionSearchAdapterOptions): TrentToolAdapter {
  const sessionsDir = options.sessionsDir ?? path.join(options.profileDir, "sessions");
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    toRecord(SESSION_SEARCH_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "session_search"));

  return {
    name: SESSION_SEARCH_ADAPTER_NAME,
    scopes: [...SESSION_SEARCH_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(SESSION_SEARCH_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    /** A read of files this profile already owns. */
    requiresApproval: () => false,
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") return record(action, "failed", 'session_search needs a non-empty "query".');
      const sessionId = typeof args.session_id === "string" && args.session_id.trim() !== "" ? args.session_id.trim() : undefined;
      const limit = intArg(args.limit, SESSION_SEARCH_DEFAULT_LIMIT, 1, SESSION_SEARCH_MAX_LIMIT);
      const sessions = new SessionStore(sessionsDir).list();
      const result = searchSessions(sessions, query, { limit, ...(sessionId === undefined ? {} : { sessionId }) });
      return record(action, "completed", renderHits(query, result.backend, result.hits));
    },
    async cleanup() {},
  };
}
