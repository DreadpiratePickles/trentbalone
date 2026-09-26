/**
 * Named memory blocks: the shape `memory.blocks[]` takes in config and the three blocks every
 * profile ships with. A block is one file under `<profile>/memories/`, addressed by its label in
 * the `memory` tool, with its own character limit and its own write rule. `read_only` blocks are
 * read by every seat and written only by the founder (editing the file) or the heartbeat; a seat
 * that tries is refused with the label in the tool result.
 *
 * Pure data: no I/O, so `config/schema.ts` can import the defaults without a cycle.
 */

export interface MemoryBlock {
  /** The name a seat passes as `block`; `^[a-z][a-z0-9_-]{1,30}$`. */
  readonly label: string;
  /** File name under `<profile>/memories/`, e.g. `MEMORY.md`. */
  readonly file: string;
  /** One line every seat reads in its prelude: what belongs in this block. */
  readonly description: string;
  /** Hard character cap, checked on the final state of a batch. */
  readonly limit: number;
  /** Seats may only read; the founder or the heartbeat writes. */
  readonly read_only: boolean;
}

export const MEMORY_BLOCK_LABEL_PATTERN = /^[a-z][a-z0-9_-]{1,30}$/;

export const DEFAULT_MEMORY_BLOCKS: readonly MemoryBlock[] = [
  {
    label: "memory",
    file: "MEMORY.md",
    description: "durable facts about the company and how it works",
    limit: 2200,
    read_only: false,
  },
  {
    label: "user",
    file: "USER.md",
    description: "who the founder is and how they want to be worked with",
    limit: 1375,
    read_only: false,
  },
  {
    label: "company",
    file: "COMPANY.md",
    description: "shared facts every seat reads; edited by the founder or the heartbeat",
    limit: 1500,
    read_only: true,
  },
];

/** [CF] C15.1: the shipped blocks' descriptions as a solo prompt says them: one person, no seats, no founder. */
const SOLO_DESCRIPTIONS: Readonly<Record<string, string>> = {
  memory: "durable facts, decisions and conventions worth keeping from one conversation to the next",
  user: "who you work for and how they want to be worked with",
  company: "facts about the person's company; edited by hand",
};

/** [CF] A block's description in solo: the solo words for a shipped block the profile did not re-describe, else its own. */
export function soloBlockDescription(block: MemoryBlock): string {
  const shipped = DEFAULT_MEMORY_BLOCKS.find((candidate) => candidate.label === block.label);
  return shipped?.description === block.description ? (SOLO_DESCRIPTIONS[block.label] ?? block.description) : block.description;
}

/** The block for a label, or undefined; labels are unique within one configured list. */
export function findBlock(blocks: readonly MemoryBlock[], label: string): MemoryBlock | undefined {
  return blocks.find((b) => b.label === label);
}

/**
 * Rejects a block list a seat could not address unambiguously: a repeated label or a repeated
 * file. Throws because this is configuration, not a tool call; the config schema catches the
 * per-field shape earlier.
 */
export function assertDistinctBlocks(blocks: readonly MemoryBlock[]): void {
  const labels = new Set<string>();
  const files = new Set<string>();
  for (const block of blocks) {
    if (labels.has(block.label)) throw new Error(`memory.blocks: label "${block.label}" appears more than once`);
    if (files.has(block.file)) throw new Error(`memory.blocks: file "${block.file}" is claimed by more than one block`);
    labels.add(block.label);
    files.add(block.file);
  }
  if (blocks.length === 0) throw new Error("memory.blocks: at least one block is required");
}
