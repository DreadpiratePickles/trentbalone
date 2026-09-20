/**
 * A3 — `session_search`: full text over past transcripts.
 *
 * Two backends, one row shape. FTS5 when SQLite has it (`store/session-fts.ts`), a lexical scan
 * over the JSON transcripts when it does not. The assertions below run the SAME expectations
 * against both, because a fallback that answers differently from the real index is a second
 * product nobody tested.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFtsAvailable } from "../store/session-fts.js";
import { SessionStore } from "./SessionStore.js";
import { searchSessions, type SessionSearchBackend } from "./search.js";

let sessionsDir: string;

const PHRASE = "the egress proxy refused the metadata endpoint";

beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-session-search-"));
});

afterEach(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

function seed(): SessionStore {
  const store = new SessionStore(sessionsDir);
  const old = store.createNew("engineer", "scripted-model", "scripted");
  old.title = "Egress hardening";
  old.messages = [
    { id: "m1", role: "user", content: "why did the fetch fail", timestamp: "2026-09-01T10:00:00.000Z" },
    { id: "m2", role: "assistant", content: `Because ${PHRASE} before the request left the sandbox.`, timestamp: "2026-09-01T10:00:05.000Z" },
  ];
  store.save(old, { touch: false });

  const other = store.createNew("ceo", "scripted-model", "scripted");
  other.title = "Pricing";
  other.messages = [
    { id: "m1", role: "user", content: "what should the founding price be", timestamp: "2026-09-02T10:00:00.000Z" },
  ];
  store.save(other, { touch: false });
  return store;
}

// A build of SQLite without FTS5 is a real deployment, not a hypothetical: there the index half
// of this contract cannot be asserted at all, and the lexical half is what ships.
const BACKENDS: SessionSearchBackend[] = sessionFtsAvailable() ? ["fts5", "lexical"] : ["lexical"];

describe.each(BACKENDS)("searchSessions on the %s backend", (backend) => {
  it("finds a phrase in an old session with its snippet", () => {
    const store = seed();
    const result = searchSessions(store.list(), "metadata endpoint", { backend });

    expect(result.backend).toBe(backend);
    expect(result.hits.length).toBeGreaterThan(0);
    const hit = result.hits[0]!;
    expect(hit.sessionId).toBe(store.list().find((s) => s.title === "Egress hardening")?.id);
    expect(hit.messageIndex).toBe(1);
    expect(hit.timestamp).toBe("2026-09-01T10:00:05.000Z");
    expect(hit.snippet).toContain("metadata endpoint");
  });

  it("returns nothing rather than a guess when no transcript matches", () => {
    const store = seed();
    const result = searchSessions(store.list(), "kubernetes ingress annotations", { backend });
    expect(result.hits).toEqual([]);
  });

  it("bounds the result set to the requested limit", () => {
    const store = seed();
    const result = searchSessions(store.list(), "the founding price", { backend, limit: 1 });
    expect(result.hits.length).toBeLessThanOrEqual(1);
  });
});

describe("searchSessions backend selection", () => {
  it("prefers FTS5 and falls back to the lexical scan when SQLite has no FTS5", () => {
    const store = seed();
    const auto = searchSessions(store.list(), "metadata endpoint");
    expect(["fts5", "lexical"]).toContain(auto.backend);
    expect(auto.hits[0]?.snippet).toContain("metadata endpoint");
  });
});

/**
 * [X5] Time windows and exclusions. "What did we decide last week" is a question about WHEN as
 * much as WHAT: the same phrase in a session a week earlier must not answer it. `after`/`before`
 * take an ISO instant or a shorthand window (`24h`, `7d`, `2w`) measured back from `now`, which
 * the caller passes so the tests never depend on the clock.
 */
describe("[X5] searchSessions time windows and exclusions", () => {
  const NOW = "2026-09-20T12:00:00.000Z";
  const PHRASE = "we decided to ship the founding price";

  function seedTwoWeeks(): { store: SessionStore; recent: string; old: string } {
    const store = new SessionStore(sessionsDir);
    const old = store.createNew("ceo", "scripted-model", "scripted");
    old.title = "Pricing, two weeks ago";
    old.messages = [{ id: "m1", role: "assistant", content: `${PHRASE} at 49.`, timestamp: "2026-09-08T09:00:00.000Z" }];
    store.save(old, { touch: false });
    const recent = store.createNew("ceo", "scripted-model", "scripted");
    recent.title = "Pricing, this week";
    recent.messages = [{ id: "m1", role: "assistant", content: `${PHRASE} at 59.`, timestamp: "2026-09-17T09:00:00.000Z" }];
    store.save(recent, { touch: false });
    return { store, recent: recent.id, old: old.id };
  }

  it("parses ISO instants and the shorthand windows relative to now", async () => {
    const { parseSearchInstant } = await import("./search.js");
    const nowMs = Date.parse(NOW);
    expect(parseSearchInstant("2026-09-13T00:00:00.000Z", nowMs)).toBe(Date.parse("2026-09-13T00:00:00.000Z"));
    expect(parseSearchInstant("24h", nowMs)).toBe(nowMs - 24 * 60 * 60 * 1000);
    expect(parseSearchInstant("7d", nowMs)).toBe(nowMs - 7 * 24 * 60 * 60 * 1000);
    expect(parseSearchInstant("2w", nowMs)).toBe(nowMs - 14 * 24 * 60 * 60 * 1000);
    expect(parseSearchInstant("last tuesday", nowMs)).toBeUndefined();
    expect(parseSearchInstant("", nowMs)).toBeUndefined();
  });

  it("finds the phrase only in the window asked for", () => {
    const { store, recent, old } = seedTwoWeeks();
    const thisWeek = searchSessions(store.list(), PHRASE, { after: "7d", now: NOW });
    expect(thisWeek.hits.map((hit) => hit.sessionId)).toEqual([recent]);
    const earlier = searchSessions(store.list(), PHRASE, { before: "7d", now: NOW });
    expect(earlier.hits.map((hit) => hit.sessionId)).toEqual([old]);
    const both = searchSessions(store.list(), PHRASE, { after: "2w", now: NOW });
    expect(new Set(both.hits.map((hit) => hit.sessionId))).toEqual(new Set([recent, old]));
    const none = searchSessions(store.list(), PHRASE, { after: "24h", now: NOW });
    expect(none.hits).toEqual([]);
  });

  it("takes ISO bounds and leaves out excluded sessions", () => {
    const { store, recent, old } = seedTwoWeeks();
    const iso = searchSessions(store.list(), PHRASE, { after: "2026-09-10T00:00:00.000Z", before: "2026-09-18T00:00:00.000Z", now: NOW });
    expect(iso.hits.map((hit) => hit.sessionId)).toEqual([recent]);
    const excluded = searchSessions(store.list(), PHRASE, { excludeSessionIds: [recent], now: NOW });
    expect(excluded.hits.map((hit) => hit.sessionId)).toEqual([old]);
  });

  it("refuses a bound it cannot read rather than silently searching everything", () => {
    const { store } = seedTwoWeeks();
    expect(() => searchSessions(store.list(), PHRASE, { after: "last tuesday", now: NOW })).toThrow(/after/);
  });
});
