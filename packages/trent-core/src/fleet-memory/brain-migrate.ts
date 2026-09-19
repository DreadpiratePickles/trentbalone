/**
 * [C2] The one-time, idempotent migration of the memory blocks into the brain.
 *
 * `<profile>/memories/MEMORY.md` becomes `<profile>/brain/system/memory.md`, byte for byte. Not
 * "roughly the same content": the bytes are copied, because a founder's memory block that comes
 * back re-wrapped or re-ordered is a data loss with a friendly name, and because
 * `consolidate.ts`'s rollback path restores a block by its exact prior bytes.
 *
 * The old path is left holding a POINTER — a short line naming the brain file — rather than being
 * deleted. An operator who opens the path they have always opened is told where the content went
 * instead of finding nothing, and `memoryPath()` (`tools/memory/store.ts`) has already followed
 * the block to the brain, so every reader and writer in the block store reads the new file. The
 * pointer stays until somebody removes it.
 *
 * Idempotence is decided by one fact on disk: `brain/system/<block>.md` exists. A second run
 * reports the block as already migrated and writes nothing at all — not the brain file, not the
 * pointer, not a commit.
 */
import fs from "node:fs";
import path from "node:path";

import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";
import { brainSystemFileName, memoryFileName, withMemoryFileLock, type MemoryFileRef } from "../tools/memory/store.js";
import { DEFAULT_MEMORY_BLOCKS, type MemoryBlock } from "../tools/memory/blocks.js";
import { BRAIN_SYSTEM_DIR, BRAIN_SYSTEM_FILES, brainRoot, type Brain, type BrainAuthor } from "./brain.js";

const FILE_MODE = 0o600;

/** The brain file one block migrates into: `MEMORY.md` becomes `memory.md`. */
export function brainSystemFileFor(ref: MemoryFileRef): string {
  return brainSystemFileName(memoryFileName(ref));
}

export interface MigratedBlock {
  /** The legacy file name, e.g. `MEMORY.md`. */
  readonly file: string;
  readonly label: string;
  /** The brain path it now lives at, relative to the brain root. */
  readonly brainPath: string;
  readonly bytes: number;
}

export interface MigrateBlocksResult {
  readonly migrated: readonly MigratedBlock[];
  /** Legacy file names whose brain copy already existed; nothing was written for these. */
  readonly alreadyMigrated: readonly string[];
  /** Blocks with no file on disk yet: there is nothing to move. */
  readonly absent: readonly string[];
}

export interface MigrateBlocksOptions {
  readonly profileDir: string;
  readonly brain: Brain;
  /** `config.memory.blocks`; the three shipped blocks when omitted. */
  readonly blocks?: readonly MemoryBlock[];
  readonly author?: BrainAuthor;
}

function pointerText(brainRelative: string, file: string): string {
  return (
    `This block moved into the brain repository.\n\n` +
    `Its content is now ${brainRelative}, which is the file Trent reads and writes.\n` +
    `This pointer is left so an older reader of ${file} finds the content instead of nothing; ` +
    `deleting it changes nothing.\n`
  );
}

/**
 * Migrate every configured block that has a file and no brain copy yet. Throws — rather than
 * overwriting — when a block's file name would shadow one of the brain's own system files, because
 * `brain/system/identity.md` holding a configured block instead of the identity is a corruption
 * the next prompt would carry silently.
 */
export function migrateBlocksToBrain(options: MigrateBlocksOptions): MigrateBlocksResult {
  const blocks = options.blocks ?? DEFAULT_MEMORY_BLOCKS;
  const author = options.author ?? { writer: "human" };
  const root = brainRoot(options.profileDir);
  const migrated: MigratedBlock[] = [];
  const alreadyMigrated: string[] = [];
  const absent: string[] = [];

  for (const block of blocks) {
    const target = brainSystemFileFor(block);
    if (BRAIN_SYSTEM_FILES.includes(target)) {
      throw new Error(
        `memory block "${block.label}" (${block.file}) would be migrated to brain/system/${target}, ` +
          `which is one of the brain's own always-loaded files. Rename the block's file in config.yaml.`,
      );
    }
    const legacy = path.join(options.profileDir, "memories", block.file);
    const destination = path.join(root, BRAIN_SYSTEM_DIR, target);
    if (fs.existsSync(destination)) {
      alreadyMigrated.push(block.file);
      continue;
    }
    if (!fs.existsSync(legacy)) {
      absent.push(block.file);
      continue;
    }

    options.brain.ensure();
    // Under the legacy file's OWN lock: a seat appending to the block in this window is
    // serialised before or after the copy, never interleaved with it.
    const bytes = withMemoryFileLock(legacy, () => {
      const contents = fs.readFileSync(legacy, "utf8");
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      atomicWriteFileSync(NODE_IO, destination, contents, FILE_MODE);
      atomicWriteFileSync(NODE_IO, legacy, pointerText(`brain/${BRAIN_SYSTEM_DIR}/${target}`, block.file), FILE_MODE);
      return contents.length;
    });
    migrated.push({ file: block.file, label: block.label, brainPath: `${BRAIN_SYSTEM_DIR}/${target}`, bytes });
  }

  if (migrated.length > 0) {
    options.brain.writeFile(
      `${BRAIN_SYSTEM_DIR}/.migrated`,
      `${migrated.map((m) => `${m.file} -> ${m.brainPath}`).join("\n")}\n`,
      author,
    );
  }
  return { migrated, alreadyMigrated, absent };
}
