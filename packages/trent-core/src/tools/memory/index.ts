/**
 * The `memory` toolset: Hermes's `memory(target, action|operations)` over `<profile>/memories/`.
 *
 * MEMORY.md holds what the agent learned (2200 chars); USER.md holds what it knows about the
 * person (1375 chars). Both are rendered once per session by `frozenSnapshot()` for the prompt,
 * so the model reasons over a stable view while writes land on disk for the NEXT session.
 * Delegated seats are constructed `readOnly` and can never write.
 */
import fs from "node:fs";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import {
  ENTRY_SEPARATOR,
  MEMORY_CAPS,
  applyOperations,
  memoryPath,
  readEntries,
  writeEntries,
  type MemoryOperation,
  type MemoryTarget,
} from "./store.js";

export { MEMORY_CAPS, ENTRY_SEPARATOR, MEMORY_FILES, applyOperations } from "./store.js";
export type { MemoryOperation, MemoryTarget } from "./store.js";

export const MEMORY_ADAPTER_NAME = "memory";
const SPECS: readonly ToolSpec[] = [{ name: "memory", primary: "content", signature: ["target"] }];
const ROUTING_TEXT =
  "remember this, save a note for later, memory, recall preferences, record a fact about the user, " +
  "persist across sessions, forget, update what you know";

export const MEMORY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "memory",
    description:
      "Persist a durable note. target=memory for what you learned about the work (2200 chars total), " +
      "target=user for facts about the person (1375 chars total). Use a single action, or a batch of " +
      "operations that is applied atomically; the cap is checked on the final state, so remove and " +
      "add in one call to make room. Entries are short; the current contents are already in your prompt.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user"] },
        action: { type: "string", enum: ["add", "replace", "remove"] },
        content: { type: "string", description: "New entry text (add, replace)." },
        old_text: { type: "string", description: "Unique substring of the entry to replace or remove." },
        operations: {
          type: "array",
          description: "Batch form: [{action, content?, old_text?}] applied in order, all or nothing.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["add", "replace", "remove"] },
              content: { type: "string" },
              old_text: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["target"],
    },
  },
];

export interface MemoryAdapterOptions {
  profileDir: string;
  /** Delegated seats: every write is refused. */
  readOnly?: boolean;
}

export interface MemoryAdapter extends TrentToolAdapter {
  /** Both files rendered once; later calls return the same text even if the files change. */
  frozenSnapshot(): string;
}

function isTarget(v: unknown): v is MemoryTarget {
  return v === "memory" || v === "user";
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

function renderFile(profileDir: string, target: MemoryTarget): string {
  const file = memoryPath(profileDir, target);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  return text || "(empty)";
}

export function createMemoryAdapter(options: MemoryAdapterOptions): MemoryAdapter {
  let snapshot: string | null = null;

  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(MEMORY_ADAPTER_NAME, action, status, summary);

  return {
    name: MEMORY_ADAPTER_NAME,
    scopes: [MEMORY_ADAPTER_NAME, "memory:write", "memory:read"],
    availability: "real",
    instructions: renderToolInstructions(MEMORY_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    async cleanup() {},
    frozenSnapshot() {
      if (snapshot === null) {
        snapshot =
          `## MEMORY.md (agent notes, ${MEMORY_CAPS.memory}-char cap)\n${renderFile(options.profileDir, "memory")}\n\n` +
          `## USER.md (about the person, ${MEMORY_CAPS.user}-char cap)\n${renderFile(options.profileDir, "user")}`;
      }
      return snapshot;
    },
    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      if (!isTarget(args.target)) return record(action, "failed", "\"target\" must be \"memory\" or \"user\".");
      if (options.readOnly) {
        return record(action, "blocked", "This seat is delegated and has read-only memory. Report the fact to the parent instead.");
      }
      const ops = toOperations(args);
      if (typeof ops === "string") return record(action, "failed", `memory: ${ops}.`);

      const target = args.target;
      const cap = MEMORY_CAPS[target];
      const result = applyOperations(readEntries(options.profileDir, target), ops, cap);
      if (!result.ok) return record(action, "failed", `memory(${target}) refused: ${result.reason}`);
      try {
        writeEntries(options.profileDir, target, result.rendered);
      } catch (err) {
        return record(action, "failed", `memory(${target}) write failed: ${(err as Error).message}`);
      }
      return record(
        action,
        "completed",
        `memory(${target}): applied ${ops.length} operation(s); ${result.entries.length} entries, ` +
          `${result.rendered.length} chars used, ${result.remaining} remaining of ${cap}. ` +
          `Takes effect in the next session; your prompt keeps this session's snapshot.`
      );
    },
    async dryRun(action) {
      return record(action, "mocked", `memory dry-run: would apply "${action}" (entries are separated by "${ENTRY_SEPARATOR.trim()}").`);
    },
  };
}
