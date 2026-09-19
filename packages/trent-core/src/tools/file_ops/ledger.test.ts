/**
 * E1 item 1 — the ledger hook inside `file_ops`.
 *
 * The adapter is the only place an agent's file write exists before it lands, so it is the only
 * place the pre-image can be captured. This suite runs the real adapter on the local backend and
 * asserts the rows it leaves: hashes that match the bytes, no row for a write that changes
 * nothing, and — end to end — a rollback that puts the workspace back byte for byte.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, closeCheckpointSession, openCheckpointSession, type CheckpointSession } from "../../checkpoints/index.js";
import { createFileOpsAdapter } from "./index.js";
import type { TrentToolAdapter } from "../types.js";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const ORIGINAL = "export const VERSION = \"1.2.3\";\n";

let workspace = "";
let profileDir = "";
let adapter: TrentToolAdapter;
let session: CheckpointSession;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fileops-ledger-"));
  workspace = path.join(root, "repo");
  profileDir = path.join(root, "profile");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "a.ts"), ORIGINAL);
  adapter = createFileOpsAdapter({ workspace, profileDir, backend: "local", autoApproveWrites: true });
  session = openCheckpointSession({ runId: "run_ops", workspace, profileDir, seat: "engineer" });
});

afterEach(async () => {
  closeCheckpointSession();
  await adapter.cleanup();
});

describe("file_ops writes through the checkpoint ledger", () => {
  it("ledgers a write_file with the pre-image and both hashes", async () => {
    const content = "export const VERSION = \"9.9.9\";\n";
    const result = await adapter.execute(`write_file ${JSON.stringify({ path: "src/a.ts", content })}`, {});
    expect(result.status).toBe("completed");

    const rows = session.store.entries("run_ops");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("write_file");
    expect(rows[0]?.path).toBe("src/a.ts");
    expect(rows[0]?.seat).toBe("engineer");
    expect(rows[0]?.turn).toBe(1);
    expect(rows[0]?.step).toBe(1);
    expect(rows[0]?.before_hash).toBe(sha256(ORIGINAL));
    expect(rows[0]?.after_hash).toBe(sha256(content));
    expect(fs.readFileSync(session.store.preImagePath(rows[0]?.before_bytes_ref ?? ""))).toEqual(Buffer.from(ORIGINAL));
  }, 120_000);

  it("ledgers a patch, and a created file with no pre-image", async () => {
    await adapter.execute(`patch ${JSON.stringify({ path: "src/a.ts", old_string: "1.2.3", new_string: "2.0.0" })}`, {});
    await adapter.execute(`write_file ${JSON.stringify({ path: "notes/new.md", content: "fresh\n" })}`, {});
    const rows = session.store.entries("run_ops");
    expect(rows.map((row) => row.tool)).toEqual(["patch", "write_file"]);
    expect(rows[0]?.before_hash).toBe(sha256(ORIGINAL));
    expect(rows[0]?.after_hash).toBe(sha256(ORIGINAL.replace("1.2.3", "2.0.0")));
    expect(rows[1]?.before_hash).toBeNull();
    expect(rows[1]?.before_bytes_ref).toBeNull();
    expect(rows[1]?.step).toBe(2);
  }, 120_000);

  it("records nothing new for a second identical write", async () => {
    const action = `write_file ${JSON.stringify({ path: "src/a.ts", content: "same\n" })}`;
    await adapter.execute(action, {});
    await adapter.execute(action, {});
    expect(session.store.entries("run_ops")).toHaveLength(1);
  }, 120_000);

  it("puts later writes in the turn the session opened for them, and rollback undoes exactly those", async () => {
    await adapter.execute(`write_file ${JSON.stringify({ path: "src/a.ts", content: "turn one\n" })}`, {});
    session.beginTurn();
    await adapter.execute(`write_file ${JSON.stringify({ path: "src/b.ts", content: "turn two\n" })}`, {});
    expect(session.listCheckpoints().map((c) => c.turn)).toEqual([1, 2]);

    const result = session.rollback({ to: 1 });
    expect(result.ok).toBe(true);
    expect(result.restored.map((r) => r.path)).toEqual(["src/b.ts"]);
    expect(fs.existsSync(path.join(workspace, "src", "b.ts"))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8")).toBe("turn one\n");

    expect(new CheckpointStore({ workspace, profileDir }).rollback({ runId: "run_ops", to: 0 }).ok).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8")).toBe(ORIGINAL);
  }, 120_000);

  it("records nothing when no checkpoint session is open", async () => {
    closeCheckpointSession();
    await adapter.execute(`write_file ${JSON.stringify({ path: "src/a.ts", content: "unledgered\n" })}`, {});
    expect(session.store.entries("run_ops")).toHaveLength(0);
    expect(fs.readFileSync(path.join(workspace, "src", "a.ts"), "utf8")).toBe("unledgered\n");
  }, 120_000);
});
