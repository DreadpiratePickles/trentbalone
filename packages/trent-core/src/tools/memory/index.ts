/**
 * The `memory` toolset: Hermes's `memory(target, action|operations)` over `<profile>/memories/`,
 * generalised to named blocks (T4.3).
 *
 * A block is one file with a label, a description, a character limit and a write rule, listed in
 * config `memory.blocks[]` (`blocks.ts` holds the defaults: `memory` = MEMORY.md, 2200 chars,
 * `user` = USER.md, 1375 chars, and the read-only `company` = COMPANY.md, 1500 chars). All are
 * COMPANY memory: one set of files per profile, shared by every seat (ceo, engineer, growth, ...
 * and any installed specialist). They are rendered once per run by `frozenSnapshot()` for every
 * seat's prelude, so each model reasons over a stable view while writes land on disk for the NEXT
 * run (`thaw()` ends the freeze; the fleet hook calls it when a run settles). Delegated children
 * read the snapshot like everyone else but can never write: either the adapter is constructed
 * `readOnly`, or `callerContext()` reports the current step as delegated. A `read_only` block is
 * refused for every seat, naming the label. Hermes blocks subagent memory entirely; Trent allows
 * the read.
 */
import fs from "node:fs";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { DEFAULT_MEMORY_BLOCKS, assertDistinctBlocks, findBlock, type MemoryBlock } from "./blocks.js";
import { ENTRY_SEPARATOR, checkMemoryWriteGate, commitOperations, memoryLimit, memoryPath, type ApplyResult, type MemoryOperation } from "./store.js";

export { DEFAULT_MEMORY_BLOCKS, MEMORY_BLOCK_LABEL_PATTERN, assertDistinctBlocks, findBlock } from "./blocks.js";
export type { MemoryBlock } from "./blocks.js";
export {
  MEMORY_CAPS,
  ENTRY_SEPARATOR,
  MEMORY_FILES,
  CONSOLIDATION_WRITE_GATE,
  SEAT_WRITE_GATE,
  applyOperations,
  checkMemoryWriteGate,
  commitOperations,
  commitReplaceAll,
  memoryBlockIsReadOnly,
  memoryLimit,
  parseEntries,
  readEntries,
  // [C2] the brain: where a block's bytes actually live, and the lock the brain shares with them.
  brainSystemFileName,
  brainSystemPath,
  memoryFileName,
  memoryPath,
  withMemoryFileLock,
} from "./store.js";
export type { ApplyResult, MemoryFileRef, MemoryLimitSource, MemoryOperation, MemoryTarget, MemoryWriteGate, MemoryWriter } from "./store.js";

export const MEMORY_ADAPTER_NAME = "memory";
const DEFAULT_BLOCK_LABEL = "memory";
const SPECS: readonly ToolSpec[] = [{ name: "memory", primary: "content", signature: ["target"] }];
const ROUTING_TEXT =
  "remember this, save a note for later, memory, recall preferences, record a fact about the user, " +
  "persist across sessions, forget, update what you know";

function describeBlocks(blocks: readonly MemoryBlock[]): string {
  return blocks
    .map((b) => `${b.label} = ${b.description} (${b.limit} chars total${b.read_only ? ", read-only for seats" : ""})`)
    .join("; ");
}

/** The tool schema for one configured block list; the enum and the description name every label. */
export function memoryToolSchemas(blocks: readonly MemoryBlock[]): ToolSchema[] {
  const writable = blocks.filter((b) => !b.read_only).map((b) => b.label);
  return [
    {
      name: "memory",
      description:
        "Add a durable note shared by every seat in the company. Blocks: " +
        `${describeBlocks(blocks)}. \`block\` (alias \`target\`) names the block and defaults to "${DEFAULT_BLOCK_LABEL}". ` +
        "Adding is the only write a seat makes: entries are replaced, merged and removed by the nightly " +
        "consolidation, which the founder promotes, so nothing you record is edited away mid-run. Use a single " +
        "action, or a batch of adds applied atomically; the cap is checked on the final state. Entries are short; " +
        "the current contents are already in your prompt.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", enum: writable, description: `Block label to write; defaults to "${DEFAULT_BLOCK_LABEL}".` },
          block: { type: "string", enum: writable, description: "Same as target." },
          action: { type: "string", enum: ["add"] },
          content: { type: "string", description: "New entry text." },
          operations: {
            type: "array",
            description: "Batch form: [{action, content}] applied in order, all or nothing.",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["add"] },
                content: { type: "string" },
              },
              required: ["action"],
            },
          },
        },
        required: ["target"],
      },
    },
  ];
}

/** The schema over the default blocks, for surfaces that list tools before any config is loaded. */
export const MEMORY_TOOL_SCHEMAS: ToolSchema[] = memoryToolSchemas(DEFAULT_MEMORY_BLOCKS);

/** What the fleet hook knows about the step currently calling the tool. */
export interface MemoryCallerContext {
  /** A `[delegated]` child step: reads are fine, writes are refused. */
  readonly delegated: boolean;
}

export interface MemoryAdapterOptions {
  profileDir: string;
  /** The named blocks (config `memory.blocks`); the three defaults when omitted. */
  blocks?: readonly MemoryBlock[];
  /** A permanently read-only adapter: every write is refused. */
  readOnly?: boolean;
  /** Consulted on every write; lets one shared adapter refuse writes from delegated child steps. */
  callerContext?: () => MemoryCallerContext;
}

export interface MemoryAdapter extends TrentToolAdapter {
  /** The blocks this adapter serves, in prelude order. */
  readonly blocks: readonly MemoryBlock[];
  /** Every block rendered once; later calls return the same text even if the files change. */
  frozenSnapshot(): string;
  /** Ends the freeze: the next `frozenSnapshot()` re-reads the files. Called between runs. */
  thaw(): void;
  /** Installs (or replaces) the caller-context provider; the fleet hook binds its step tracker here. */
  bindCallerContext(provider: () => MemoryCallerContext): void;
}

/** `block` wins, `target` is the Hermes-era alias, and the default block takes an unnamed write. */
function requestedLabel(args: Record<string, unknown>): string {
  if (typeof args.block === "string") return args.block;
  if (typeof args.target === "string") return args.target;
  return DEFAULT_BLOCK_LABEL;
}

function toOperations(args: Record<string, unknown>): MemoryOperation[] | string {
  if (Array.isArray(args.operations)) {
    if (!args.operations.length) return "\"operations\" is empty";
    const ops: MemoryOperation[] = [];
    for (const raw of args.operations) {
      if (!raw || typeof raw !== "object") return "each operation must be an object";
      const r = raw as Record<string, unknown>;
      ops.push({
        action: r.action as MemoryOperation["action"],
        content: typeof r.content === "string" ? r.content : undefined,
        old_text: typeof r.old_text === "string" ? r.old_text : undefined,
      });
    }
    return ops;
  }
  if (typeof args.action !== "string") return "provide \"action\" (add|replace|remove) or \"operations\"";
  return [
    {
      action: args.action as MemoryOperation["action"],
      content: typeof args.content === "string" ? args.content : undefined,
      old_text: typeof args.old_text === "string" ? args.old_text : undefined,
    },
  ];
}

/**
 * The block as it stands on disk right now, appended to a refusal. Without it a seat that hits the
 * limit has only its frozen prelude to work from, which cannot show what another seat just wrote.
 */
function renderRefusalState(result: Extract<ApplyResult, { ok: false }>): string {
  if (result.entries === undefined || result.limit === undefined) return "";
  const header = `\nCurrently stored (${result.entries.length} entries, ${String(result.used)} of ${String(result.limit)} chars):`;
  return result.entries.length === 0
    ? `${header} the block is empty.`
    : `${header}\n${result.entries.map((entry, i) => `${i + 1}. ${entry}`).join("\n")}`;
}

/** One prelude section per block: file, label, description, limit, bytes used and the write rule. */
function renderBlock(profileDir: string, block: MemoryBlock): string {
  const file = memoryPath(profileDir, block);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  const rule = block.read_only ? "; read-only for seats" : "";
  return (
    `## ${block.file} (${block.label}: ${block.description}; ${block.limit}-char cap, ${text.length} chars used${rule})\n` +
    (text || "(empty)")
  );
}

export function createMemoryAdapter(options: MemoryAdapterOptions): MemoryAdapter {
  const blocks = options.blocks ?? DEFAULT_MEMORY_BLOCKS;
  assertDistinctBlocks(blocks);
  const labels = blocks.map((b) => b.label).join(", ");
  let snapshot: string | null = null;
  let callerContext = options.callerContext;

  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(MEMORY_ADAPTER_NAME, action, status, summary);

  return {
    name: MEMORY_ADAPTER_NAME,
    blocks,
    scopes: [MEMORY_ADAPTER_NAME, "memory:write", "memory:read"],
    availability: "real",
    instructions: renderToolInstructions(memoryToolSchemas(blocks)),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    async cleanup() {},
    frozenSnapshot() {
      snapshot ??= blocks.map((block) => renderBlock(options.profileDir, block)).join("\n\n");
      return snapshot;
    },
    thaw() {
      snapshot = null;
    },
    bindCallerContext(provider) {
      callerContext = provider;
    },
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const label = requestedLabel(args);
      const block = findBlock(blocks, label);
      if (!block) return record(action, "failed", `memory: unknown block "${label}"; the blocks are ${labels}.`);
      if (options.readOnly || callerContext?.().delegated) {
        return record(action, "blocked", "This seat is delegated and has read-only memory. Report the fact to the parent instead.");
      }
      if (block.read_only) {
        return record(
          action,
          "blocked",
          `memory(${label}) is read-only for seats: ${block.file} is edited by the founder or the heartbeat. ` +
            "Ask the founder to record the fact, or use a writable block."
        );
      }
      const ops = toOperations(args);
      if (typeof ops === "string") return record(action, "failed", `memory: ${ops}.`);

      // [C4] The layer gate: a seat appends, and nothing else. A replace or a remove would edit an
      // entry another seat wrote, which is the consolidation draft's job and the founder's call.
      const gate = { writer: "seat" as const, blocks };
      const gated = checkMemoryWriteGate(block, ops, gate);
      if (gated !== null) return record(action, "blocked", `memory(${label}) refused: ${gated}`);

      // The writer resolves the limit from the CONFIGURED blocks, so an override of a default
      // block's limit is enforced by the write and not only shown in the prelude.
      const cap = memoryLimit(block, blocks);
      let result: ReturnType<typeof commitOperations>;
      try {
        result = commitOperations(options.profileDir, block, ops, { blocks }, gate);
      } catch (err) {
        return record(action, "failed", `memory(${label}) write failed: ${(err as Error).message}`);
      }
      if (!result.ok) {
        // The entries and the usage travel with the refusal so the seat can consolidate in this
        // same turn — its prelude snapshot was frozen before this write and may already be stale.
        return record(action, "failed", `memory(${label}) refused: ${result.reason}${renderRefusalState(result)}`);
      }
      return record(
        action,
        "completed",
        `memory(${label}): applied ${ops.length} operation(s); ${result.entries.length} entries, ` +
          `${result.rendered.length} chars used, ${result.remaining} remaining of ${cap}. ` +
          `Shared with every seat in the company from the next run on; your prompt keeps this run's snapshot.`
      );
    },
    async dryRun(action) {
      return record(action, "mocked", `memory dry-run: would apply "${action}" (entries are separated by "${ENTRY_SEPARATOR.trim()}").`);
    },
  };
}
