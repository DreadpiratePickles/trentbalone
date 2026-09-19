/**
 * [C2] The one-time migration of `<profile>/memories/*.md` into `<profile>/brain/system/`.
 *
 * Two properties decide whether this migration is safe to ship: the content is byte-identical on
 * the other side, and a second run does nothing. A migration that reformats, re-wraps or re-orders
 * a founder's memory block is a data loss with a friendly name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MEMORY_BLOCKS, readEntries, memoryPath } from "../tools/memory/index.js";
import { brainRoot, createBrain, type BrainExec } from "./brain.js";
import { brainSystemFileFor, migrateBlocksToBrain } from "./brain-migrate.js";

let profileDir: string;

const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

const MEMORY_BYTES = "Trent runs standalone on Bobby's machine.\n§\nThe fiscal year starts in April.";
const USER_BYTES = "Bobby prefers short answers with the command and its exit code.";

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-mig-")));
  fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), MEMORY_BYTES, "utf8");
  fs.writeFileSync(path.join(profileDir, "memories", "USER.md"), USER_BYTES, "utf8");
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("migrating the memory blocks into the brain", () => {
  it("moves each block byte-identically and leaves a pointer at the old path", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    const result = migrateBlocksToBrain({ profileDir, brain, blocks: DEFAULT_MEMORY_BLOCKS });

    expect(result.migrated.map((m) => m.file).sort()).toEqual(["MEMORY.md", "USER.md"]);
    expect(fs.readFileSync(path.join(brainRoot(profileDir), "system", "memory.md"), "utf8")).toBe(MEMORY_BYTES);
    expect(fs.readFileSync(path.join(brainRoot(profileDir), "system", "user.md"), "utf8")).toBe(USER_BYTES);

    // The old path is still there, and names where the content went.
    const pointer = fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8");
    expect(pointer).toContain("brain/system/memory.md");
    expect(pointer).not.toContain("The fiscal year starts in April");
  });

  it("is idempotent: a second run migrates nothing and changes no byte", () => {
    const brain = createBrain({ profileDir, exec: noGit });
    migrateBlocksToBrain({ profileDir, brain, blocks: DEFAULT_MEMORY_BLOCKS });
    const before = fs.readFileSync(path.join(brainRoot(profileDir), "system", "memory.md"), "utf8");
    const pointerBefore = fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8");

    const again = migrateBlocksToBrain({ profileDir, brain, blocks: DEFAULT_MEMORY_BLOCKS });
    expect(again.migrated).toEqual([]);
    expect([...again.alreadyMigrated]).toContain("MEMORY.md");
    expect(fs.readFileSync(path.join(brainRoot(profileDir), "system", "memory.md"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8")).toBe(pointerBefore);
  });

  it("makes the block store read the brain copy afterwards", () => {
    const block = DEFAULT_MEMORY_BLOCKS[0]!;
    expect(memoryPath(profileDir, block)).toBe(path.join(profileDir, "memories", "MEMORY.md"));

    const brain = createBrain({ profileDir, exec: noGit });
    migrateBlocksToBrain({ profileDir, brain, blocks: DEFAULT_MEMORY_BLOCKS });

    expect(memoryPath(profileDir, block)).toBe(path.join(brainRoot(profileDir), "system", "memory.md"));
    // A ref that carries only the file name — a consolidation draft does — resolves the same way.
    expect(memoryPath(profileDir, { file: "MEMORY.md" })).toBe(path.join(brainRoot(profileDir), "system", "memory.md"));
    expect(readEntries(profileDir, block)).toEqual([
      "Trent runs standalone on Bobby's machine.",
      "The fiscal year starts in April.",
    ]);
  });

  it("migrates a configured extra block and refuses one that would shadow a brain file", () => {
    fs.writeFileSync(path.join(profileDir, "memories", "PRODUCT.md"), "the product ships as one binary", "utf8");
    const blocks = [
      ...DEFAULT_MEMORY_BLOCKS,
      { label: "product", file: "PRODUCT.md", description: "what we sell", limit: 800, read_only: false },
    ];
    const brain = createBrain({ profileDir, exec: noGit });
    const result = migrateBlocksToBrain({ profileDir, brain, blocks });
    expect(result.migrated.map((m) => m.file)).toContain("PRODUCT.md");
    expect(brainSystemFileFor({ file: "PRODUCT.md" })).toBe("product.md");

    const clashing = [{ label: "identity", file: "IDENTITY.md", description: "who we are", limit: 500, read_only: false }];
    fs.writeFileSync(path.join(profileDir, "memories", "IDENTITY.md"), "clash", "utf8");
    expect(() => migrateBlocksToBrain({ profileDir, brain, blocks: clashing })).toThrow(/identity\.md/);
  });

  it("migrates nothing when there is nothing to migrate", () => {
    fs.rmSync(path.join(profileDir, "memories"), { recursive: true, force: true });
    const brain = createBrain({ profileDir, exec: noGit });
    const result = migrateBlocksToBrain({ profileDir, brain, blocks: DEFAULT_MEMORY_BLOCKS });
    expect(result.migrated).toEqual([]);
    expect(fs.existsSync(path.join(brainRoot(profileDir), "system", "memory.md"))).toBe(false);
  });
});
