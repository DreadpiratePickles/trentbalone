/**
 * E1 item 2 — checkpoints and rollback.
 *
 * A checkpoint is the ledger position at the start of a turn. `rollback({ to })` keeps every
 * write up to and including turn `to` and undoes everything after it, newest first, byte-exact.
 * Two refusals are load-bearing: a file a human edited after the agent wrote it is never
 * silently overwritten, and a pre-image the budget dropped cannot be pretended back.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./index.js";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

let workspace = "";
let profileDir = "";
let store: CheckpointStore;

const read = (relative: string): string => fs.readFileSync(path.join(workspace, relative), "utf8");

function seed(relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
  fs.writeFileSync(path.join(workspace, relative), content);
}

/** Records the write AND performs it, exactly as the file_ops hook does. */
function agentWrite(turn: number, step: number, relative: string, after: string): void {
  const target = path.join(workspace, relative);
  const before = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
  store.record({ runId: "run_a", turn, step, seat: "engineer", tool: "write_file", path: relative, before, after: Buffer.from(after) });
  seed(relative, after);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-rollback-"));
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  store = new CheckpointStore({ workspace, profileDir });
  seed("a.txt", "a original\n");
  seed("b.txt", "b original\n");
  agentWrite(1, 1, "a.txt", "a turn one\n");
  agentWrite(2, 1, "b.txt", "b turn two\n");
  agentWrite(2, 2, "c.txt", "c turn two\n");
});

describe("checkpoints and rollback", () => {
  it("lists one checkpoint per turn with the files that turn touched", () => {
    const checkpoints = store.listCheckpoints("run_a");
    expect(checkpoints.map((c) => c.turn)).toEqual([1, 2]);
    expect(checkpoints[0]?.files).toEqual(["a.txt"]);
    expect(checkpoints[1]?.files).toEqual(["b.txt", "c.txt"]);
    expect(checkpoints[0]?.position).toBe(0);
    expect(checkpoints[1]?.position).toBe(1);
  });

  it("rolls back to turn 1 byte-exact, leaving turn 1's own write in place", () => {
    const result = store.rollback({ runId: "run_a", to: 1 });
    expect(result.ok).toBe(true);
    expect(result.refused).toEqual([]);
    expect(result.restored.map((r) => r.path).sort()).toEqual(["b.txt", "c.txt"]);
    expect(read("a.txt")).toBe("a turn one\n");
    expect(read("b.txt")).toBe("b original\n");
    expect(fs.existsSync(path.join(workspace, "c.txt"))).toBe(false);
  });

  it("records the rollback itself in the ledger", () => {
    store.rollback({ runId: "run_a", to: 1 });
    const rows = store.entries("run_a").filter((row) => row.tool === "rollback");
    expect(rows.map((row) => row.path).sort()).toEqual(["b.txt", "c.txt"]);
    expect(rows.find((row) => row.path === "b.txt")?.after_hash).toBe(sha256("b original\n"));
    expect(rows.find((row) => row.path === "c.txt")?.after_hash).toBeNull();
  });

  it("refuses a file changed on disk since the agent wrote it, and restores nothing", () => {
    seed("b.txt", "a human edited this\n");
    const result = store.rollback({ runId: "run_a", to: 1 });
    expect(result.ok).toBe(false);
    expect(result.restored).toEqual([]);
    expect(result.refused.map((r) => r.path)).toEqual(["b.txt"]);
    expect(result.refused[0]?.reason).toMatch(/changed on disk/);
    expect(read("b.txt")).toBe("a human edited this\n");
    expect(read("c.txt")).toBe("c turn two\n");
  });

  it("--force overrides the drift refusal", () => {
    seed("b.txt", "a human edited this\n");
    const result = store.rollback({ runId: "run_a", to: 1, force: true });
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(true);
    expect(read("b.txt")).toBe("b original\n");
  });

  it("refuses a path whose pre-image the byte budget dropped", () => {
    const tight = new CheckpointStore({ workspace, profileDir, maxBytesPerRun: 1 });
    seed("d.txt", "d original\n");
    tight.record({ runId: "run_b", turn: 1, step: 1, seat: "engineer", tool: "write_file", path: "d.txt", before: Buffer.from("d original\n"), after: Buffer.from("d changed\n") });
    seed("d.txt", "d changed\n");
    const result = tight.rollback({ runId: "run_b", to: 0 });
    expect(result.ok).toBe(false);
    expect(result.refused[0]?.reason).toMatch(/pre-image/);
    expect(read("d.txt")).toBe("d changed\n");
  });

  it("is idempotent: rolling back twice to the same turn refuses nothing", () => {
    expect(store.rollback({ runId: "run_a", to: 1 }).ok).toBe(true);
    const second = store.rollback({ runId: "run_a", to: 1 });
    expect(second.ok).toBe(true);
    expect(read("b.txt")).toBe("b original\n");
    expect(fs.existsSync(path.join(workspace, "c.txt"))).toBe(false);
  });

  it("reports an unknown run and an out-of-range checkpoint instead of touching the workspace", () => {
    const missing = store.rollback({ runId: "run_zzz", to: 1 });
    expect(missing.ok).toBe(false);
    expect(missing.refused[0]?.reason).toMatch(/no ledger|nothing/i);
    const ahead = store.rollback({ runId: "run_a", to: 9 });
    expect(ahead.ok).toBe(true);
    expect(ahead.restored).toEqual([]);
    expect(read("c.txt")).toBe("c turn two\n");
  });
});
