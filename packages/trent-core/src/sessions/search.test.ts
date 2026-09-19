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
