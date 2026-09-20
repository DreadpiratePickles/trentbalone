/**
 * A3 — the `session_search` tool: what a seat calls to read its own past.
 *
 * The ranking itself is proved in `sessions/search.test.ts` against both backends. What is proved
 * here is the adapter contract: it reads the profile's real transcript directory, it reports the
 * session id, the message index, the timestamp and a snippet, and an empty result says so instead
 * of returning a plausible-looking nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../sessions/SessionStore.js";
import { createSessionSearchAdapter, SESSION_SEARCH_ADAPTER_NAME } from "./index.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-session-search-tool-"));
  const store = new SessionStore(path.join(profileDir, "sessions"));
  const session = store.createNew("engineer", "scripted-model", "scripted");
  session.title = "Egress hardening";
  session.messages = [
    {
      id: "m1",
      role: "assistant",
      content: "The egress proxy refused the cloud metadata endpoint before the request left the sandbox.",
      timestamp: "2026-09-01T10:00:05.000Z",
    },
  ];
  store.save(session, { touch: false });
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("session_search", () => {
  it("finds a phrase in an old session and names where it is", async () => {
    const adapter = createSessionSearchAdapter({ profileDir });
    const result = await adapter.execute('session_search {"query":"cloud metadata endpoint"}', {});

    expect(result.status).toBe("completed");
    expect(result.adapter).toBe(SESSION_SEARCH_ADAPTER_NAME);
    expect(result.summary).toContain("metadata endpoint");
    expect(result.summary).toContain("2026-09-01T10:00:05.000Z");
    expect(result.summary).toContain("sess_");
  });

  it("says plainly when no transcript matches", async () => {
    const adapter = createSessionSearchAdapter({ profileDir });
    const result = await adapter.execute('session_search {"query":"kubernetes ingress annotations"}', {});

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("no session");
  });

  // [X5] Windows and exclusions ride the same action. The seed above is dated 2026-09-01; the
  // second session here is a week later, and the tool is told what "now" is through the option
  // the CLI and the tests share, so the shorthand windows are asserted against a fixed clock.
  it("finds a phrase only inside the window asked for, and leaves excluded sessions out", async () => {
    const store = new SessionStore(path.join(profileDir, "sessions"));
    const later = store.createNew("engineer", "scripted-model", "scripted");
    later.title = "Egress hardening, again";
    later.messages = [
      { id: "m1", role: "assistant", content: "The egress proxy refused the cloud metadata endpoint a second time.", timestamp: "2026-09-08T10:00:05.000Z" },
    ];
    store.save(later, { touch: false });
    const adapter = createSessionSearchAdapter({ profileDir, now: () => "2026-09-10T00:00:00.000Z" });

    const recent = await adapter.execute('session_search {"query":"cloud metadata endpoint","after":"7d"}', {});
    expect(recent.status).toBe("completed");
    expect(recent.summary).toContain(later.id);
    expect(recent.summary).not.toContain("2026-09-01T10:00:05.000Z");

    const earlier = await adapter.execute('session_search {"query":"cloud metadata endpoint","before":"2026-09-05T00:00:00.000Z"}', {});
    expect(earlier.summary).toContain("2026-09-01T10:00:05.000Z");
    expect(earlier.summary).not.toContain(later.id);

    const excluded = await adapter.execute(`session_search {"query":"cloud metadata endpoint","exclude_session_ids":["${later.id}"]}`, {});
    expect(excluded.summary).toContain("2026-09-01T10:00:05.000Z");
    expect(excluded.summary).not.toContain(later.id);

    const unreadable = await adapter.execute('session_search {"query":"cloud metadata endpoint","after":"last tuesday"}', {});
    expect(unreadable.status).toBe("failed");
    expect(unreadable.summary).toContain("after");
  });

  it("documents the window and exclusion parameters in its schema", async () => {
    const { SESSION_SEARCH_TOOL_SCHEMAS } = await import("./index.js");
    const properties = SESSION_SEARCH_TOOL_SCHEMAS[0]!.parameters.properties as Record<string, { description: string }>;
    for (const key of ["after", "before", "exclude_session_ids"]) expect(properties[key]?.description).toBeTruthy();
    expect(properties.after!.description).toMatch(/7d/);
  });

  it("is a pure read: it never asks for approval", () => {
    const adapter = createSessionSearchAdapter({ profileDir });
    expect(adapter.requiresApproval('session_search {"query":"anything"}')).toBe(false);
  });
});
