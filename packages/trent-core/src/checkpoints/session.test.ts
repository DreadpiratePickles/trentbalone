/**
 * E1 — the turn boundary and the process-level session `file_ops` finds.
 *
 * Two surfaces open a turn for the same piece of work: the headless runtime does it per run, and
 * a surface above it may do it per turn. Opening a turn nobody has written into must therefore be
 * a no-op, or the turn numbers a human types into `/rollback` would skip and every second
 * checkpoint would be empty. Closing is scoped for the same reason a session is: a runtime that
 * has already been replaced must not close the session that replaced it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeCheckpointSession, closeCheckpointSession, openCheckpointSession, type CheckpointSession } from "./index.js";

let workspace = "";
let profileDir = "";
let session: CheckpointSession;

function write(relative: string, content: string): void {
  session.record({ tool: "write_file", path: relative, before: undefined, after: Buffer.from(content) });
  fs.writeFileSync(path.join(workspace, relative), content);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-ckpt-session-"));
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  session = openCheckpointSession({ runId: "sess_1", workspace, profileDir, seat: "engineer" });
});

afterEach(() => {
  closeCheckpointSession();
});

describe("the checkpoint session's turn boundary", () => {
  it("opening a turn nobody wrote into keeps the same turn", () => {
    expect(session.beginTurn()).toBe(1);
    expect(session.beginTurn()).toBe(1);
    write("a.txt", "a\n");
    expect(session.beginTurn()).toBe(2);
    expect(session.beginTurn()).toBe(2);
    write("b.txt", "b\n");
    expect(session.listCheckpoints().map((c) => c.turn)).toEqual([1, 2]);
  });

  it("a write with no turn opened is turn 1, and steps count from 1 inside each turn", () => {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    session.beginTurn("planner");
    write("c.txt", "c\n");
    const rows = session.store.entries("sess_1");
    expect(rows.map((row) => [row.turn, row.step])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(rows[2]?.seat).toBe("planner");
  });

  it("is the session `file_ops` finds, and closes only the session that is still open", () => {
    expect(activeCheckpointSession()).toBe(session);
    const second = openCheckpointSession({ runId: "sess_2", workspace, profileDir });
    closeCheckpointSession(session);
    expect(activeCheckpointSession()).toBe(second);
    closeCheckpointSession(second);
    expect(activeCheckpointSession()).toBeUndefined();
  });
});
