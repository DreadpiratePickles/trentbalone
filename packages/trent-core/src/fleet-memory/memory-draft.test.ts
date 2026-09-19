/**
 * [C4] The bytes a memory draft carries and the one way they reach disk.
 *
 * RED for: the lock bypass (`replaceBlock` wrote a block holding byte-identical duplicates with no
 * lock at all, so a seat's concurrent append could be lost between its read and this rename), and
 * for the draft payload carrying the op list beside the resulting text so a promotion and its
 * rollback stay byte-exact.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MEMORY_BLOCKS, type MemoryBlock } from "../tools/memory/blocks.js";
import { ENTRY_SEPARATOR, memoryPath, readEntries } from "../tools/memory/store.js";
import { applyMemoryBytes, decodeMemoryDraft, encodeMemoryDraft, replaceBlock } from "./memory-draft.js";

const tmpDirs: string[] = [];
const COMPANY = DEFAULT_MEMORY_BLOCKS.find((b) => b.label === "company") as MemoryBlock;

function profile(memory: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-draft-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  fs.writeFileSync(memoryPath(dir, "memory"), memory, "utf8");
  return dir;
}

/** Holds the memory file's lock the way a crashed-or-busy peer writer would. */
function holdLock(dir: string, target: Parameters<typeof memoryPath>[1]): () => void {
  const lock = `${memoryPath(dir, target)}.lock`;
  fs.mkdirSync(lock);
  return () => fs.rmdirSync(lock);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("every write path takes the block lock", () => {
  const DUPLICATES = ["Ship on Fridays.", "Ship on Fridays.", "Invoices go out on the 1st."].join(ENTRY_SEPARATOR);
  const CLEAN = ["Ship on Fridays.", "Invoices go out on the 1st."].join(ENTRY_SEPARATOR);

  it("a block holding byte-identical duplicates waits for the lock instead of writing through it", () => {
    const dir = profile(DUPLICATES);
    const release = holdLock(dir, "memory");
    try {
      expect(() => replaceBlock(dir, "memory", "Ship on Fridays.")).toThrow(/lock/i);
      expect(fs.readFileSync(memoryPath(dir, "memory"), "utf8")).toBe(DUPLICATES);
    } finally {
      release();
    }
    replaceBlock(dir, "memory", "Ship on Fridays.");
    expect(fs.readFileSync(memoryPath(dir, "memory"), "utf8")).toBe("Ship on Fridays.");
    expect(fs.statSync(memoryPath(dir, "memory")).mode & 0o777).toBe(0o600);
  }, 20_000);

  it("a block with no duplicates waits for the same lock", () => {
    const dir = profile(CLEAN);
    const release = holdLock(dir, "memory");
    try {
      expect(() => replaceBlock(dir, "memory", "Ship on Fridays.")).toThrow(/lock/i);
      expect(fs.readFileSync(memoryPath(dir, "memory"), "utf8")).toBe(CLEAN);
    } finally {
      release();
    }
  }, 20_000);

  it("leaves no lock or temp file behind once it is done", () => {
    const dir = profile(DUPLICATES);
    replaceBlock(dir, "memory", CLEAN);
    expect(readEntries(dir, "memory")).toEqual(["Ship on Fridays.", "Invoices go out on the 1st."]);
    expect(fs.readdirSync(path.join(dir, "memories")).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("the draft payload carries the operations beside the resulting text", () => {
  it("round-trips the op list per block, and omits the key when there are none", () => {
    const payload = {
      profileDir: "/tmp/p",
      memory: "a",
      user: "b",
      dropped: ["gone"],
      ops: [
        { label: "memory", ops: [{ op: "remove" as const, entry_id: "e2" }] },
        { label: "user", ops: [{ op: "merge" as const, entry_ids: ["e1", "e2"], text: "b" }] },
      ],
    };
    expect(decodeMemoryDraft(encodeMemoryDraft(payload))).toEqual(payload);

    const bare = { profileDir: "/tmp/p", memory: "a", user: "b", dropped: [] };
    const encoded = encodeMemoryDraft({ ...bare, ops: [] });
    expect(JSON.parse(encoded)).toEqual(bare);
    expect(decodeMemoryDraft(encoded)).toEqual(bare);
  });

  it("refuses a payload whose operations are not the four the schema knows", () => {
    const bad = JSON.stringify({ profileDir: "/tmp/p", memory: "a", user: "b", dropped: [], ops: [{ label: "memory", ops: [{ op: "wipe" }] }] });
    expect(() => decodeMemoryDraft(bad)).toThrow();
  });
});

describe("applying draft bytes is a consolidation write", () => {
  it("writes a read_only block the draft carries, and refuses one it does not", () => {
    const dir = profile("Ship on Fridays.");
    fs.writeFileSync(memoryPath(dir, COMPANY), "Founded 2024.", "utf8");
    applyMemoryBytes(dir, {
      memory: "Ship on Fridays.",
      user: "",
      blocks: [{ label: COMPANY.label, file: COMPANY.file, limit: COMPANY.limit, text: ["Founded 2024.", "We sell to fintech."].join(ENTRY_SEPARATOR) }],
    });
    expect(readEntries(dir, COMPANY)).toEqual(["Founded 2024.", "We sell to fintech."]);
    expect(() => replaceBlock(dir, { label: COMPANY.label, file: COMPANY.file, limit: COMPANY.limit }, "anything")).toThrow(/read-only/i);
  });
});
