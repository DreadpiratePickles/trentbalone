/**
 * `trent sessions export`: the redaction boundary in `@trent/core/telemetry` was written, tested
 * and unreachable — `sessions` had list, resume and prune only. These assertions are about the
 * DEFAULT: a transcript leaves the machine without its bodies unless the caller says otherwise,
 * and even then every body goes through the redactor first.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core/config/index.js";
import { SessionManager } from "@trent/core/sessions/index.js";
import type { ExportedSession } from "@trent/core/telemetry/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;

/** A pasted credential inside a transcript: the case redaction exists for. */
const LEAKY_LINE = "deploy with OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678";

function seed(): { id: string; messages: number } {
  const manager = new SessionManager(new ConfigManager({ profile: "default" }));
  const session = manager.startSession("ceo", "scripted-model", "scripted");
  manager.appendMessage(session.id, { role: "user", content: LEAKY_LINE });
  manager.appendMessage(session.id, {
    role: "assistant",
    agent: "ceo",
    content: "Rotate that key before deploying.",
    metadata: {
      cost_cents: 12,
      run_id: "run_seed",
      tool_calls: [{ name: "terminal", args: undefined, result: undefined }],
    },
  });
  return { id: session.id, messages: 2 };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-sessions-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

interface ExportData {
  session: ExportedSession;
  path: string | null;
}

describe("trent sessions export", () => {
  it("exports structure and metrics with no message bodies by default", async () => {
    const seeded = seed();
    const result = await runCli(["sessions", "export", seeded.id, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);

    const data = JSON.parse(result.stdout) as ExportData;
    expect(data.session.id).toBe(seeded.id);
    expect(data.session.contentIncluded).toBe(false);
    expect(data.session.messageCount).toBe(seeded.messages);
    expect(data.session.messages[0]?.content).toBeUndefined();
    expect(data.session.messages[0]?.contentLength).toBe(LEAKY_LINE.length);
    expect(data.session.messages[1]?.cost_cents).toBe(12);
    expect(data.session.messages[1]?.toolCallNames).toEqual(["terminal"]);
    // The whole payload, not just the fields checked above, is free of the pasted key.
    expect(result.stdout).not.toContain("sk-proj-abc123def456ghi789jkl012mno345pqr678");
  });

  it("--include-content includes the bodies, redacted", async () => {
    const seeded = seed();
    const result = await runCli(["sessions", "export", seeded.id, "--include-content", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);

    const data = JSON.parse(result.stdout) as ExportData;
    expect(data.session.contentIncluded).toBe(true);
    expect(data.session.messages[0]?.content).toContain("deploy with");
    expect(data.session.messages[0]?.content).not.toContain("sk-proj-abc123def456ghi789jkl012mno345pqr678");
    expect(data.session.messages[1]?.content).toBe("Rotate that key before deploying.");
  });

  it("--out writes the export to the named file and reports the path", async () => {
    const seeded = seed();
    const target = path.join(home, "export.json");
    const result = await runCli(["sessions", "export", seeded.id, "--out", target, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);

    const data = JSON.parse(result.stdout) as ExportData;
    expect(data.path).toBe(target);
    const written = JSON.parse(fs.readFileSync(target, "utf8")) as ExportedSession;
    expect(written.id).toBe(seeded.id);
    expect(written.contentIncluded).toBe(false);
  });

  it("--dry-run writes nothing", async () => {
    const seeded = seed();
    const target = path.join(home, "never.json");
    const result = await runCli(["sessions", "export", seeded.id, "--out", target, "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("exits with the config code for an id no session has", async () => {
    seed();
    const result = await runCli(["sessions", "export", "ses_nothing", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
  });
});

/**
 * A3 — `trent sessions search`. The transcripts were searchable by nothing but `grep` on files the
 * store deliberately keeps at mode 0600; this is the supported way in, and `--json` is the shape a
 * surface or a script reads.
 */
describe("trent sessions search", () => {
  it("prints the session, the message index and a snippet", async () => {
    const seeded = seed();
    const result = await runCli(["sessions", "search", "rotate that key"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain(seeded.id);
    expect(result.stdout.toLowerCase()).toContain("rotate");
  });

  it("--json returns the rows", async () => {
    const seeded = seed();
    const result = await runCli(["sessions", "search", "rotate that key", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);

    const data = JSON.parse(result.stdout) as {
      query: string;
      backend: string;
      count: number;
      hits: { sessionId: string; messageIndex: number; timestamp: string; snippet: string }[];
    };
    expect(data.query).toBe("rotate that key");
    expect(["fts5", "lexical"]).toContain(data.backend);
    expect(data.count).toBe(data.hits.length);
    const hit = data.hits.find((h) => h.sessionId === seeded.id);
    expect(hit).toBeDefined();
    expect(hit?.messageIndex).toBe(1);
    expect(hit?.snippet.toLowerCase()).toContain("rotate");
    expect(typeof hit?.timestamp).toBe("string");
  });

  it("returns no rows rather than an error when nothing matches", async () => {
    seed();
    const result = await runCli(["sessions", "search", "kubernetes ingress annotations", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect((JSON.parse(result.stdout) as { hits: unknown[] }).hits).toEqual([]);
  });

  // [X5] The same windows the `session_search` tool takes: `--after 7d` here and `"after":"7d"`
  // there resolve through one parser, so a founder and a seat asking "last week" get one answer.
  describe("time windows and exclusions", () => {
    const PHRASE = "we decided to ship the founding price";
    function seedTwoWeeks(): { recent: string; old: string } {
      const manager = new SessionManager(new ConfigManager({ profile: "default" }));
      const old = manager.startSession("ceo", "scripted-model", "scripted");
      manager.appendMessage(old.id, { role: "assistant", content: `${PHRASE} at 49.` });
      const recent = manager.startSession("ceo", "scripted-model", "scripted");
      manager.appendMessage(recent.id, { role: "assistant", content: `${PHRASE} at 59.` });
      // The store stamps the clock; the test needs one session a week older than the other.
      const stored = manager.getSession(old.id)!;
      stored.messages[0]!.timestamp = new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString();
      manager.getStore().save(stored, { touch: false });
      return { recent: recent.id, old: old.id };
    }

    function ids(stdout: string): string[] {
      return (JSON.parse(stdout) as { hits: { sessionId: string }[] }).hits.map((hit) => hit.sessionId);
    }

    it("--after 7d finds only this week's session, --before only the older one", async () => {
      const { recent, old } = seedTwoWeeks();
      const week = await runCli(["sessions", "search", PHRASE, "--after", "7d", "--json"]);
      expect(week.exitCode).toBe(EXIT.OK);
      expect(ids(week.stdout)).toEqual([recent]);
      const earlier = await runCli(["sessions", "search", PHRASE, "--before", "7d", "--json"]);
      expect(ids(earlier.stdout)).toEqual([old]);
    });

    it("--exclude leaves a session out; an unreadable bound is a usage error naming it", async () => {
      const { recent, old } = seedTwoWeeks();
      const excluded = await runCli(["sessions", "search", PHRASE, "--exclude", recent, "--json"]);
      expect(ids(excluded.stdout)).toEqual([old]);
      const bad = await runCli(["sessions", "search", PHRASE, "--after", "last tuesday", "--json"]);
      expect(bad.exitCode).toBe(EXIT.USAGE);
      expect(bad.stdout).toContain("after");
    });
  });
});
