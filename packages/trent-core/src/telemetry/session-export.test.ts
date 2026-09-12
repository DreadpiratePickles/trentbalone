import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../sessions/SessionStore.js";
import { exportSession, DEFAULT_SESSION_EXPORT_OPTIONS } from "./session-export.js";

const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKE";

describe("session export boundary", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-export-"));
    store = new SessionStore(path.join(dir, "sessions"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed() {
    const s = store.createNew("engineer", "claude-sonnet-5", "anthropic");
    s.title = "Rotate the key";
    s.messages.push({
      id: "msg_1",
      role: "user",
      content: `export ANTHROPIC_API_KEY=${FAKE_KEY}`,
      timestamp: new Date().toISOString(),
    });
    s.messages.push({
      id: "msg_2",
      role: "assistant",
      content: "Rotated. Authorization: Bearer abcdef0123456789abcdef0123456789",
      timestamp: new Date().toISOString(),
      metadata: { cost_cents: 42 },
    });
    store.save(s);
    return s;
  }

  it("defaults includeContent to false", () => {
    expect(DEFAULT_SESSION_EXPORT_OPTIONS.includeContent).toBe(false);
  });

  it("omits message content entirely by default", () => {
    const s = seed();
    const exported = exportSession(store.get(s.id)!);
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("export ANTHROPIC_API_KEY");
    expect(exported.messages[0]).not.toHaveProperty("content");
    // Structure still usable for analytics.
    expect(exported.messages).toHaveLength(2);
    expect(exported.messages[0]?.role).toBe("user");
    expect(exported.total_cost_cents).toBe(s.total_cost_cents);
  });

  it("redacts content when it is explicitly opted in", () => {
    const s = seed();
    const exported = exportSession(store.get(s.id)!, { includeContent: true });
    const serialized = JSON.stringify(exported);

    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain("abcdef0123456789abcdef0123456789");
    expect(exported.messages[0]?.content).toContain("export ANTHROPIC_API_KEY=");
    expect(exported.messages[0]?.content).toContain("[REDACTED_SECRET]");
  });

  it("leaves the on-disk session intact and resumable after an export", () => {
    const s = seed();
    exportSession(store.get(s.id)!, { includeContent: true });

    const raw = fs.readFileSync(store.pathFor(s.id), "utf8");
    expect(raw).toContain(FAKE_KEY);
    expect((fs.statSync(store.pathFor(s.id)).mode & 0o777).toString(8)).toBe("600");
    expect(store.get(s.id)?.messages[0]?.content).toContain(FAKE_KEY);
  });

  it("drops tool payloads unless content is opted in", () => {
    const s = store.createNew();
    s.messages.push({
      id: "m",
      role: "tool",
      content: "ok",
      timestamp: new Date().toISOString(),
      metadata: {
        tool_calls: [{ name: "read_file", args: { path: `/etc/${FAKE_KEY}` }, result: FAKE_KEY }],
      },
    });
    store.save(s);
    const exported = exportSession(store.get(s.id)!);
    expect(JSON.stringify(exported)).not.toContain(FAKE_KEY);
    expect(exported.messages[0]?.toolCallNames).toEqual(["read_file"]);
  });
});
