/**
 * A3 — `session_search`: full text over past transcripts.
 *
 * Trent kept every session as JSON at mode 0600 and gave nobody a way in: recalling what was
 * decided three days ago meant `grep` on files the store deliberately locks down, or re-asking the
 * model. Hermes has `session_search` (inventory §1.4); this is it, with one row shape over two
 * backends — FTS5 where SQLite has it, a TF-IDF scan where it does not — because a fallback that
 * answers differently from the real index is a second product nobody tested.
 *
 * The caller passes the records: this module never opens the store itself, so a search cannot
 * widen who reads a transcript.
 */
import { rankDocuments } from "../tools/tool_search/rank.js";
import { searchWithFts, sessionFtsAvailable, type FtsDocument } from "../store/session-fts.js";
import type { SessionData } from "./schema.js";

export type SessionSearchBackend = "fts5" | "lexical";

export interface SessionSearchHit {
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly messageIndex: number;
  readonly role: string;
  readonly timestamp: string;
  readonly snippet: string;
  readonly score: number;
}

export interface SessionSearchResult {
  readonly query: string;
  readonly backend: SessionSearchBackend;
  readonly hits: SessionSearchHit[];
}

export interface SessionSearchOptions {
  /** Forces a backend. Omitted means FTS5 when this runtime has it, the lexical scan otherwise. */
  readonly backend?: SessionSearchBackend;
  readonly limit?: number;
  /** Only this session's messages. */
  readonly sessionId?: string;
  /**
   * [X5] Only messages at or after this instant: an ISO date, or a window back from `now`
   * (`24h`, `7d`, `2w`). A bound that reads as neither is refused, never ignored.
   */
  readonly after?: string;
  /** Only messages before this instant; the same forms as `after`. */
  readonly before?: string;
  /** Sessions left out of the search entirely (the current one, typically). */
  readonly excludeSessionIds?: readonly string[];
  /** The instant the shorthand windows count back from; defaults to the clock. Tests pass it. */
  readonly now?: string;
}

/** The shorthand units: hours, days and weeks, as a founder writes them (`24h`, `7d`, `2w`). */
const WINDOW_UNIT_MS: Readonly<Record<string, number>> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * [X5] An instant from either form a bound takes: an ISO date (`Date.parse` accepts it), or a
 * whole number of hours, days or weeks back from `nowMs`. Anything else is `undefined`, so the
 * caller can refuse it by name instead of searching everything.
 */
export function parseSearchInstant(raw: string | undefined, nowMs: number = Date.now()): number | undefined {
  const text = raw?.trim() ?? "";
  if (text === "") return undefined;
  const window = /^(\d+)\s*([hdw])$/i.exec(text);
  if (window) return nowMs - Number(window[1]) * WINDOW_UNIT_MS[window[2]!.toLowerCase()]!;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

interface TimeWindow {
  readonly afterMs?: number;
  readonly beforeMs?: number;
}

/** The two bounds as milliseconds. Throws for a bound that reads as neither a date nor a window. */
function windowOf(options: SessionSearchOptions): TimeWindow {
  const nowMs = options.now === undefined ? Date.now() : Date.parse(options.now);
  const bound = (name: "after" | "before"): number | undefined => {
    const raw = options[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = parseSearchInstant(raw, nowMs);
    if (parsed === undefined) {
      throw new Error(`session search: "${name}" must be an ISO date or a window such as 24h, 7d or 2w; got "${raw}"`);
    }
    return parsed;
  };
  const afterMs = bound("after");
  const beforeMs = bound("before");
  return { ...(afterMs === undefined ? {} : { afterMs }), ...(beforeMs === undefined ? {} : { beforeMs }) };
}

function inWindow(timestamp: string, window: TimeWindow): boolean {
  if (window.afterMs === undefined && window.beforeMs === undefined) return true;
  const at = Date.parse(timestamp);
  // A message with no readable timestamp cannot be shown to lie inside a window, so it is left out.
  if (Number.isNaN(at)) return false;
  if (window.afterMs !== undefined && at < window.afterMs) return false;
  if (window.beforeMs !== undefined && at >= window.beforeMs) return false;
  return true;
}

export const SESSION_SEARCH_DEFAULT_LIMIT = 10;
export const SESSION_SEARCH_MAX_LIMIT = 50;
const SNIPPET_RADIUS = 70;

interface Located extends FtsDocument {
  readonly session: SessionData;
  readonly role: string;
  readonly timestamp: string;
}

function documentsOf(sessions: readonly SessionData[], options: SessionSearchOptions): Located[] {
  const window = windowOf(options);
  const excluded = new Set(options.excludeSessionIds ?? []);
  const out: Located[] = [];
  for (const session of sessions) {
    if (options.sessionId !== undefined && session.id !== options.sessionId) continue;
    if (excluded.has(session.id)) continue;
    session.messages.forEach((message, index) => {
      const content = message.content?.trim() ?? "";
      if (content === "") return;
      // Filtered before ranking, on both backends: a row outside the window never exists to rank.
      if (!inWindow(message.timestamp, window)) return;
      out.push({
        sessionId: session.id,
        messageIndex: index,
        content,
        session,
        role: message.role,
        timestamp: message.timestamp,
      });
    });
  }
  return out;
}

/** A window around the first query term the message contains, so the caller sees why it matched. */
export function snippetAround(content: string, query: string): string {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  const haystack = content.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return content.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${content.slice(start, end).trim()}${end < content.length ? "..." : ""}`;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(SESSION_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function hitOf(located: Located, snippet: string, score: number): SessionSearchHit {
  return {
    sessionId: located.sessionId,
    sessionTitle: located.session.title,
    messageIndex: located.messageIndex,
    role: located.role,
    timestamp: located.timestamp,
    snippet,
    score,
  };
}

function lexicalSearch(documents: readonly Located[], query: string, limit: number): SessionSearchHit[] {
  const byKey = new Map(documents.map((document) => [`${document.sessionId}#${document.messageIndex}`, document]));
  const ranked = rankDocuments(
    documents.map((document) => ({
      id: `${document.sessionId}#${document.messageIndex}`,
      title: document.session.title,
      body: document.content,
    })),
    query,
  );
  const hits: SessionSearchHit[] = [];
  for (const entry of ranked) {
    const located = byKey.get(entry.id);
    // The title alone must not produce a hit: the row points at a message, so the message has to match.
    if (located === undefined || snippetMisses(located.content, query)) continue;
    hits.push(hitOf(located, snippetAround(located.content, query), entry.score));
    if (hits.length >= limit) break;
  }
  return hits;
}

function snippetMisses(content: string, query: string): boolean {
  const haystack = content.toLowerCase();
  return !query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1)
    .some((term) => haystack.includes(term));
}

/**
 * Searches the records the caller supplies. An empty query returns nothing rather than everything;
 * a bound that cannot be read throws rather than widening the search.
 */
export function searchSessions(sessions: readonly SessionData[], query: string, options: SessionSearchOptions = {}): SessionSearchResult {
  const limit = boundedLimit(options.limit);
  const trimmed = query.trim();
  const documents = documentsOf(sessions, options);
  if (trimmed === "") return { query: trimmed, backend: options.backend ?? "lexical", hits: [] };

  const wanted: SessionSearchBackend = options.backend ?? (sessionFtsAvailable() ? "fts5" : "lexical");
  if (wanted === "fts5") {
    const rows = searchWithFts(documents, trimmed, limit);
    if (rows !== undefined) {
      const byKey = new Map(documents.map((document) => [`${document.sessionId}#${document.messageIndex}`, document]));
      const hits: SessionSearchHit[] = [];
      for (const row of rows) {
        const located = byKey.get(`${row.sessionId}#${row.messageIndex}`);
        if (located === undefined) continue;
        hits.push(hitOf(located, row.snippet.trim() === "" ? snippetAround(located.content, trimmed) : row.snippet, row.score));
      }
      return { query: trimmed, backend: "fts5", hits };
    }
  }
  return { query: trimmed, backend: "lexical", hits: lexicalSearch(documents, trimmed, limit) };
}
