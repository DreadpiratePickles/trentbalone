/**
 * [S3] Checkpoints in solo (item 5; council A10).
 *
 * A solo write goes through the same agent-write ledger the fleet's does (`file_ops` records into the
 * process's open checkpoint session), so `/rollback` undoes it byte-exact. The runner names its seat
 * when it opens a turn, so every row is seat `trent`, and after a rollback the conversation is told,
 * through the runner (the conversation's only writer), which turns and paths were undone: otherwise
 * the history still says the file was written. Real `file_ops` on the local backend; scripted gateway.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeCheckpointSession, openCheckpointSession, type CheckpointSession } from "../checkpoints/index.js";
import { createFileOpsAdapter } from "../tools/file_ops/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { FIXED_NOW, collect, fakeMemory, fakeMeter, scriptedGateway, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { tempProfile, toldIn } from "./fakes-s3.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";

let root = "";
let workspace = "";
let profileDir = "";
let files: TrentToolAdapter;
let ledger: CheckpointSession;

beforeEach(() => {
  root = tempProfile("trent-solo-s3-checkpoints-");
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "notes.md"), "original notes\n");
  files = createFileOpsAdapter({ workspace, profileDir, backend: "local", autoApproveWrites: true });
  // What the headless runtime opens per session (`wireCheckpoints`), seat left to whoever opens a turn.
  ledger = openCheckpointSession({ runId: "ses_s3", workspace, profileDir });
});
afterEach(async () => {
  closeCheckpointSession();
  await files.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

const WRITE = 'write_file {"path": "notes.md", "content": "agent rewrote the notes\\n"}';
const CREATE = 'write_file {"path": "draft.md", "content": "a new draft\\n"}';

function solo(script: string[]) {
  const gateway = scriptedGateway(script);
  const session = memorySoloSession();
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: [files] },
    session,
    memory: fakeMemory().memory,
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    workspace,
    checkpoints: { beginTurn: (seat) => void ledger.beginTurn(seat) },
  });
  return { gateway, runner, session };
}

describe("[S3] a solo write is on the agent-write ledger and rolls back", () => {
  it("ledgers the write as seat trent, one checkpoint per turn, and rollback restores the workspace byte-exact", async () => {
    const { runner } = solo([toolCall(WRITE), "Rewrote the notes.", toolCall(CREATE), "Drafted."]);
    await collect(runner.run({ objective: "Rewrite the notes" }));
    await collect(runner.run({ objective: "Start a draft" }));
    expect(fs.readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("agent rewrote the notes\n");

    const rows = ledger.store.entries("ses_s3");
    expect(rows.map((row) => [row.turn, row.seat, row.path])).toEqual([
      [1, "trent", "notes.md"],
      [2, "trent", "draft.md"],
    ]);
    const result = ledger.rollback({ to: 0 });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("original notes\n");
    expect(fs.existsSync(path.join(workspace, "draft.md"))).toBe(false);
  });
});

describe("[S3] A10: the conversation is told what a rollback undid", () => {
  it("appends the runner's note, and the next turn reads it", async () => {
    const { runner, gateway, session } = solo([toolCall(WRITE), "Rewrote the notes.", "Understood: the notes are back to the original."]);
    await collect(runner.run({ objective: "Rewrite the notes" }));
    ledger.rollback({ to: 0 });

    await runner.note?.("Rollback: turn 1 and after were undone; notes.md was restored to what it held before.");
    const stored = await session.history();
    expect(stored.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("notes.md was restored") });
    await collect(runner.run({ objective: "What do the notes say now?" }));
    expect(toldIn(gateway.requests.at(-1))).toContain("notes.md was restored");
  });
});
