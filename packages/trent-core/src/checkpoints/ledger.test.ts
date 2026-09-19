/**
 * E1 item 1 — the agent-write ledger.
 *
 * The governing assertion is byte-exactness: what the ledger stores for a path must be the
 * bytes that were on disk before the agent wrote, hashed and content-addressed, inside the
 * profile directory and nowhere else. A write that changes nothing must leave no row, or a
 * rollback would "restore" a file to itself and the turn list would lie about what was touched.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CheckpointPathError, CheckpointStore } from "./index.js";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

let workspace = "";
let profileDir = "";

function makeStore(options: { maxBytesPerRun?: number; enabled?: boolean } = {}): CheckpointStore {
  return new CheckpointStore({ workspace, profileDir, ...options });
}

function write(relative: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });
  fs.writeFileSync(path.join(workspace, relative), content);
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-ledger-"));
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
});

describe("the agent-write ledger", () => {
  it("records the pre-image of an overwritten file, content-addressed and byte-exact", () => {
    const before = "one\ntwo\n";
    const after = "one\nTWO\n";
    write("src/a.ts", before);
    const store = makeStore();

    const entry = store.record({
      runId: "run_a",
      turn: 1,
      step: 1,
      seat: "engineer",
      tool: "write_file",
      path: path.join(workspace, "src/a.ts"),
      before: Buffer.from(before),
      after: Buffer.from(after),
    });

    expect(entry).toBeDefined();
    expect(entry?.path).toBe("src/a.ts");
    expect(entry?.before_hash).toBe(sha256(before));
    expect(entry?.after_hash).toBe(sha256(after));
    expect(entry?.run_id).toBe("run_a");
    expect(entry?.seat).toBe("engineer");
    expect(Date.parse(entry?.at ?? "")).not.toBeNaN();

    const ref = entry?.before_bytes_ref ?? "";
    expect(ref).not.toBe("");
    const blob = store.preImagePath(ref);
    expect(blob.startsWith(path.join(profileDir, "checkpoints") + path.sep)).toBe(true);
    expect(fs.readFileSync(blob)).toEqual(Buffer.from(before));

    const rows = store.entries("run_a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(entry);
  });

  it("records a created file with no pre-image, so a rollback knows to delete it", () => {
    const store = makeStore();
    const entry = store.record({
      runId: "run_a",
      turn: 1,
      step: 1,
      seat: "engineer",
      tool: "write_file",
      path: "notes/new.md",
      before: undefined,
      after: Buffer.from("fresh\n"),
    });
    expect(entry?.before_hash).toBeNull();
    expect(entry?.before_bytes_ref).toBeNull();
    expect(entry?.after_hash).toBe(sha256("fresh\n"));
  });

  it("records nothing for a second identical write", () => {
    write("src/a.ts", "same\n");
    const store = makeStore();
    const input = {
      runId: "run_a",
      turn: 1,
      step: 1,
      seat: "engineer",
      tool: "write_file",
      path: "src/a.ts",
      before: Buffer.from("same\n"),
      after: Buffer.from("same\n"),
    };
    expect(store.record(input)).toBeUndefined();
    expect(store.entries("run_a")).toHaveLength(0);
  });

  it("keeps the ledger and its pre-images 0600 inside 0700 directories", () => {
    write("src/a.ts", "before\n");
    const store = makeStore();
    const entry = store.record({
      runId: "run_a",
      turn: 1,
      step: 1,
      seat: "engineer",
      tool: "patch",
      path: "src/a.ts",
      before: Buffer.from("before\n"),
      after: Buffer.from("after\n"),
    });
    const mode = (p: string): number => fs.statSync(p).mode & 0o777;
    expect(mode(path.join(profileDir, "checkpoints"))).toBe(0o700);
    expect(mode(store.runDir("run_a"))).toBe(0o700);
    expect(mode(path.join(store.runDir("run_a"), "ledger.jsonl"))).toBe(0o600);
    expect(mode(store.preImagePath(entry?.before_bytes_ref ?? ""))).toBe(0o600);
  });

  it("refuses a path outside the workspace and a run id that escapes the profile", () => {
    const store = makeStore();
    const outside = path.join(os.tmpdir(), "trent-ledger-elsewhere.txt");
    expect(() =>
      store.record({ runId: "run_a", turn: 1, step: 1, seat: "s", tool: "write_file", path: outside, before: undefined, after: Buffer.from("x") }),
    ).toThrow(CheckpointPathError);
    expect(() =>
      store.record({ runId: "run_a", turn: 1, step: 1, seat: "s", tool: "write_file", path: "../escape.txt", before: undefined, after: Buffer.from("x") }),
    ).toThrow(CheckpointPathError);
    expect(() =>
      store.record({ runId: "../../etc", turn: 1, step: 1, seat: "s", tool: "write_file", path: "a.txt", before: undefined, after: Buffer.from("x") }),
    ).toThrow(CheckpointPathError);
  });

  it("over max_bytes_per_run it records hashes only, and says so", () => {
    const big = "x".repeat(4096);
    write("big.txt", big);
    const store = makeStore({ maxBytesPerRun: 1024 });
    const entry = store.record({
      runId: "run_a",
      turn: 1,
      step: 1,
      seat: "engineer",
      tool: "write_file",
      path: "big.txt",
      before: Buffer.from(big),
      after: Buffer.from("small\n"),
    });
    expect(entry?.before_hash).toBe(sha256(big));
    expect(entry?.before_bytes_ref).toBeNull();
    expect(entry?.note ?? "").toMatch(/max_bytes_per_run/);
  });

  it("records nothing at all when checkpoints are disabled", () => {
    const store = makeStore({ enabled: false });
    expect(
      store.record({ runId: "run_a", turn: 1, step: 1, seat: "s", tool: "write_file", path: "a.txt", before: undefined, after: Buffer.from("x") }),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(profileDir, "checkpoints"))).toBe(false);
  });
});
