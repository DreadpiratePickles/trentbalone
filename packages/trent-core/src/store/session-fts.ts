/**
 * A3 — the FTS5 half of `session_search`.
 *
 * SQLite's full-text index is what Hermes searches sessions with, and it is the only thing in this
 * repository that can rank a phrase across every transcript without loading each one into a
 * ranker. Three things make this file small:
 *
 *   - The index is built per query, in memory, from records the caller already holds. Transcripts
 *     live as JSON files (`sessions/SessionStore.ts`), not as rows, so there is no table to keep in
 *     step and no migration to write; retention bounds the corpus at thirty days by default.
 *   - `node:sqlite` is loaded through `createRequire` inside a try. A runtime without it (or a
 *     SQLite built without FTS5) is a supported deployment, not a crash: {@link sessionFtsAvailable}
 *     answers false and `sessions/search.ts` uses its lexical scan instead.
 *   - Nothing is written to disk. The transcripts are mode 0600 for a reason; an index of them on
 *     disk would be a second copy of the same secrets with its own permissions to get wrong.
 */
import { createRequire } from "node:module";

/** One message, as the index sees it. */
export interface FtsDocument {
  readonly sessionId: string;
  readonly messageIndex: number;
  readonly content: string;
}

export interface FtsHit {
  readonly sessionId: string;
  readonly messageIndex: number;
  readonly snippet: string;
  /** bm25 relevance, already flipped so that larger is better, as the lexical ranker reports it. */
  readonly score: number;
}

const SNIPPET_TOKENS = 12;

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

let cached: SqliteModule | null | undefined;

function loadSqlite(): SqliteModule | null {
  if (cached !== undefined) return cached;
  try {
    const required = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
    cached = typeof required?.DatabaseSync === "function" ? required : null;
  } catch {
    cached = null;
  }
  return cached;
}

let available: boolean | undefined;

/** True when this runtime has SQLite AND that SQLite was built with FTS5. Probed once. */
export function sessionFtsAvailable(): boolean {
  if (available !== undefined) return available;
  const sqlite = loadSqlite();
  if (sqlite === null) {
    available = false;
    return available;
  }
  try {
    const db = new sqlite.DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
      available = true;
    } finally {
      db.close();
    }
  } catch {
    available = false;
  }
  return available;
}

/** `a "b" c` -> `"a" OR "b" OR "c"`: every term is a literal, so no input can be FTS5 syntax. */
export function ftsQuery(query: string): string {
  const terms = query
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term !== "");
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * Ranks the documents with FTS5, best first. Returns undefined — never an empty list — when the
 * index could not be used, so the caller can tell "no SQLite" from "no match".
 */
export function searchWithFts(documents: readonly FtsDocument[], query: string, limit: number): FtsHit[] | undefined {
  const sqlite = loadSqlite();
  const match = ftsQuery(query);
  if (sqlite === null || !sessionFtsAvailable() || match === "" || documents.length === 0) return undefined;
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE messages USING fts5(session_id UNINDEXED, message_index UNINDEXED, content)");
    const insert = db.prepare("INSERT INTO messages(session_id, message_index, content) VALUES (?, ?, ?)");
    for (const document of documents) insert.run(document.sessionId, String(document.messageIndex), document.content);
    const rows = db
      .prepare(
        "SELECT session_id AS sessionId, message_index AS messageIndex, " +
          `snippet(messages, 2, '', '', '...', ${SNIPPET_TOKENS}) AS snippet, bm25(messages) AS rank ` +
          "FROM messages WHERE messages MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(match, limit) as { sessionId: string; messageIndex: string; snippet: string; rank: number }[];
    return rows.map((row) => ({
      sessionId: row.sessionId,
      messageIndex: Number(row.messageIndex),
      snippet: row.snippet,
      score: -row.rank,
    }));
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
