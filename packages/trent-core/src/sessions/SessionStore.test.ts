import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./SessionStore.js";
import { SESSION_SCHEMA_VERSION } from "./schema.js";

const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKE";

function modeOf(p: string): string {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

describe("SessionStore hardening", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-store-"));
    store = new SessionStore(path.join(dir, "sessions"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the sessions directory with mode 0700", () => {
    expect(modeOf(path.join(dir, "sessions"))).toBe("700");
  });

  it("writes every session file with mode 0600 on create", () => {
    const s = store.createNew();
    expect(modeOf(store.pathFor(s.id))).toBe("600");
  });

  it("re-asserts mode 0600 when rewriting a pre-existing 0644 file", () => {
    const s = store.createNew();
    const p = store.pathFor(s.id);
    fs.chmodSync(p, 0o644);
    expect(modeOf(p)).toBe("644");

    s.title = "rewritten";
    store.save(s);

    expect(modeOf(p)).toBe("600");
    expect(store.get(s.id)?.title).toBe("rewritten");
  });

  it("writes atomically, leaving no temp files behind", () => {
    const s = store.createNew();
    store.save(s);
    const leftovers = fs
      .readdirSync(path.join(dir, "sessions"))
      .filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("stamps the current schemaVersion on new sessions", () => {
    const s = store.createNew();
    expect(s.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    const raw = JSON.parse(fs.readFileSync(store.pathFor(s.id), "utf8")) as {
      schemaVersion: number;
    };
    expect(raw.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
  });

  it("keeps cost as integer cents and exposes a derived dollar view", () => {
    const s = store.createNew();
    s.total_cost_cents = 1234;
    store.save(s);
    const back = store.get(s.id);
    expect(back?.total_cost_cents).toBe(1234);
    expect(back?.total_cost).toBeCloseTo(12.34, 10);
  });

  it("round-trips a transcript containing a real-looking key for resume", () => {
    const s = store.createNew();
    s.messages.push({
      id: "msg_1",
      role: "user",
      content: `deploy with ANTHROPIC_API_KEY=${FAKE_KEY} please`,
      timestamp: new Date().toISOString(),
    });
    store.save(s);

    const onDisk = fs.readFileSync(store.pathFor(s.id), "utf8");
    // The user owns this file; resume must work verbatim.
    expect(onDisk).toContain(FAKE_KEY);
    expect(store.get(s.id)?.messages[0]?.content).toContain(FAKE_KEY);
    expect(modeOf(store.pathFor(s.id))).toBe("600");
  });

  it("migrates a legacy float-dollar session on read and rewrites it hardened", () => {
    const legacyDir = path.join(dir, "sessions");
    const legacy = {
      id: "sess_legacy",
      title: "Old session",
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      agent: "ceo",
      model: "gpt-5.6-terra",
      provider: "openai",
      status: "completed",
      total_cost: 12.34,
      total_duration_ms: 4200,
      messages: [
        {
          id: "msg_a",
          role: "assistant",
          content: "hello",
          timestamp: "2025-01-01T00:00:00.000Z",
          metadata: { cost: 0.29, duration_ms: 100 },
        },
      ],
    };
    const p = path.join(legacyDir, "sess_legacy.json");
    fs.writeFileSync(p, JSON.stringify(legacy, null, 2), "utf8");
    fs.chmodSync(p, 0o644);

    const loaded = store.get("sess_legacy");
    expect(loaded?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
    expect(loaded?.total_cost_cents).toBe(1234);
    expect(loaded?.messages[0]?.metadata?.cost_cents).toBe(29);
    expect(modeOf(p)).toBe("600");
  });

  it("quarantines a corrupt session file instead of crashing listSessions", () => {
    const good = store.createNew();
    const bad = path.join(dir, "sessions", "sess_corrupt.json");
    fs.writeFileSync(bad, "{ this is not json", "utf8");

    const list = store.list();
    expect(list.map((s) => s.id)).toEqual([good.id]);
    expect(fs.existsSync(bad)).toBe(false);

    const quarantined = fs.readdirSync(path.join(dir, "sessions", "quarantine"));
    expect(quarantined.some((f) => f.startsWith("sess_corrupt.json"))).toBe(true);
    // Never silently dropped: the bytes survive.
    const kept = fs.readFileSync(
      path.join(dir, "sessions", "quarantine", quarantined[0]!),
      "utf8",
    );
    expect(kept).toBe("{ this is not json");
  });

  it("prunes by maxAgeDays, defaulting to 30 days", () => {
    const old = store.createNew();
    old.updated_at = new Date(Date.now() - 40 * 86_400_000).toISOString();
    store.save(old, { touch: false });
    const fresh = store.createNew();

    const result = store.pruneSessions();
    expect(result.removed).toEqual([old.id]);
    expect(store.list().map((s) => s.id)).toEqual([fresh.id]);
  });

  it("prunes by maxCount, keeping the newest", async () => {
    const a = store.createNew();
    await new Promise((r) => setTimeout(r, 15));
    const b = store.createNew();
    await new Promise((r) => setTimeout(r, 15));
    const c = store.createNew();

    const result = store.pruneSessions({ maxCount: 2 });
    expect(result.removed).toEqual([a.id]);
    expect(store.list().map((s) => s.id).sort()).toEqual([b.id, c.id].sort());
  });

  it("never deletes the session currently being resumed", () => {
    const active = store.createNew();
    active.updated_at = new Date(Date.now() - 400 * 86_400_000).toISOString();
    store.save(active, { touch: false });
    const other = store.createNew();
    other.updated_at = new Date(Date.now() - 401 * 86_400_000).toISOString();
    store.save(other, { touch: false });

    const result = store.pruneSessions({
      maxAgeDays: 1,
      maxCount: 1,
      activeSessionId: active.id,
    });

    expect(result.removed).toEqual([other.id]);
    expect(store.get(active.id)).not.toBeNull();
  });
});
