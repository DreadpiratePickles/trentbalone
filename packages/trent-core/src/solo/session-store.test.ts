/**
 * [S2] Council A1: in solo the runner is the ONLY writer of the conversation. A profile session
 * (the REPL's, a gateway thread's) is backed by `SessionManager` itself, so what the runner appends
 * is the transcript on disk and what the next turn replays; the surface appends nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import { SessionManager } from "../sessions/SessionManager.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, scriptedGateway, sequentialIds, toolCall, transcriptOf } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession, profileSoloSession } from "./session-store.js";

const READ = 'read_file {"path": "README.md"}';

let dir: string;
let sessions: SessionManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-session-"));
  sessions = new SessionManager(new ConfigManager({ baseDir: dir }));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("[S2] profileSoloSession: the runner is the only writer (A1)", () => {
  it("one turn with one tool call leaves exactly [user, assistant(block), tool, assistant] in the session file", async () => {
    const id = sessions.startSession("trent", "gemini-test", "google").id;
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "README: hello" }) });
    const gateway = scriptedGateway([toolCall(READ), "The README says hello.", "Yes, it said hello."]);
    const runner = createSoloRunner({ gateway, tools: { adapters: [files] }, session: profileSoloSession(sessions, id), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds() });

    await collect(runner.run({ objective: "What does the README say?" }));

    const stored = new SessionManager(new ConfigManager({ baseDir: dir })).getSession(id)?.messages ?? [];
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(stored[0]).toMatchObject({ content: "What does the README say?", metadata: { run_id: "solo_1" } });
    expect(stored[1]?.content).toBe(toolCall(READ));
    expect(stored[2]?.metadata).toMatchObject({ run_id: "solo_1", tool_record: { adapter: "file_ops", action: READ, status: "completed", summary: "README: hello" } });
    expect(stored[3]).toMatchObject({ content: "The README says hello.", agent: "trent" });

    // The next turn replays the file, once: the tool result comes back from its stored record.
    await collect(runner.run({ objective: "Did it say hello?" }));
    const told = transcriptOf(gateway.requests[2]).join("\n");
    expect(told.split("README: hello").length - 1).toBe(1);
    expect(told.split("What does the README say?").length - 1).toBe(1);
    expect(new SessionManager(new ConfigManager({ baseDir: dir })).getSession(id)?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
  });

  it("reads a session another process wrote, and skips an answer the user interrupted", async () => {
    const id = sessions.startSession("trent", "gemini-test", "google").id;
    sessions.appendMessage(id, { role: "user", content: "first" });
    sessions.appendMessage(id, { role: "assistant", content: "half an ans", metadata: { status: "interrupted" } });
    sessions.appendMessage(id, { role: "user", content: "second" });
    const history = await profileSoloSession(sessions, id).history();
    expect(history.map((m) => [m.role, m.content])).toEqual([["user", "first"], ["user", "second"]]);
  });

  it("refuses a session id the profile does not hold, instead of writing nowhere", async () => {
    await expect(profileSoloSession(sessions, "sess_missing").append([{ role: "user", content: "x" }])).rejects.toThrow(/sess_missing/);
  });
});

describe("[S2] memorySoloSession: a conversation that lives in this process only", () => {
  it("keeps what it is given, oldest first", async () => {
    const session = memorySoloSession();
    await session.append([{ role: "user", content: "a" }]);
    await session.append([{ role: "assistant", content: "b", runId: "solo_1" }]);
    expect(await session.history()).toEqual([{ role: "user", content: "a" }, { role: "assistant", content: "b", runId: "solo_1" }]);
  });
});
