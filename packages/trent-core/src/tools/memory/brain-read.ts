/**
 * [C2] `brain_read {"path": "<path>"}` or `{"id": "<chunk id>"}` — the tool that turns a signpost
 * or a citation into a body.
 *
 * The stable tier lists the brain's file tree as paths and nothing else: the bodies of `memory/`,
 * `decisions/` and `seats/` stay out of the prompt until an objective needs one. The context tier
 * lists recall hits as CHUNKS with ids (`lease#7 #p3`). This adapter is how a seat fetches either,
 * and it is deliberately the smallest tool in the fleet: one argument, no write path, no approval,
 * no network. A chunk id returns that chunk with its neighbours (one before, one after) and the
 * citation to repeat, so the 400-character snippet in the prompt can be expanded without paying
 * for the whole document.
 *
 * The guard is the reason it is its own module. The path comes from a model, and a model's context
 * includes whatever it has read this run — an MCP result, a web page, a delegated child's output.
 * So the path is refused unless it is relative, free of `..`, inside the brain after resolution,
 * AND still inside the brain after the real path is taken, which is what stops a symlink planted
 * in the brain from serving `config.yaml` or a key file. Refusals never echo the target's content.
 */
import fs from "node:fs";
import path from "node:path";

import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { brainRoot, resolveBrainPath } from "../../fleet-memory/brain.js";
import { brainCitation } from "../../fleet-memory/brain-index.js";
import { chunkBrainFile, pathForChunkHead } from "../../fleet-memory/ingest/brain-chunks.js";
import { parseChunkId, type DocumentChunk } from "../../fleet-memory/ingest/chunk.js";

export const BRAIN_READ_ADAPTER_NAME = "brain_read";

/** Cap on what one call returns. A brain file over this is read in full on disk, not in a prompt. */
export const BRAIN_READ_MAX_CHARS = 12_000;

const SPECS: readonly ToolSpec[] = [{ name: "brain_read", primary: "path", signature: ["path"] }];

const ROUTING_TEXT =
  "read a brain file, open a decision, what did we decide, read the note from that day, " +
  "open a file listed in the brain tree, seat notes, expand a recalled chunk, read the cited document page";

export const BRAIN_READ_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "brain_read",
    description:
      "Read from the company brain: one file by the path listed in your prompt's brain file tree " +
      "(for example decisions/2026-09-18-the-decision.md), or one chunk by the id a brain recall " +
      "line carries (for example lease#7), which returns that chunk with the chunk before and after " +
      "it and the citation to repeat. Read-only, and only inside the brain.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "A path relative to the brain root, exactly as the file tree lists it." },
        id: { type: "string", description: "A chunk id from a brain recall line, such as lease#7 or decisions/2026-09-18-x.md#2." },
      },
      required: [],
    },
  },
];

export interface BrainReadAdapterOptions {
  readonly profileDir: string;
  /** Cap on one call's returned characters; the shipped bound when omitted. */
  readonly maxChars?: number;
}

function renderChunk(chunk: DocumentChunk, label: string): string {
  return `## ${chunk.id}${label}\n${chunk.text}`;
}

export function createBrainReadAdapter(options: BrainReadAdapterOptions): TrentToolAdapter {
  const root = brainRoot(options.profileDir);
  const maxChars = options.maxChars ?? BRAIN_READ_MAX_CHARS;
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    toRecord(BRAIN_READ_ADAPTER_NAME, action, status, summary);

  /** The second half of the guard: where the path actually lands once links are followed. */
  function insideBrain(absolute: string): boolean {
    let real: string;
    let realRoot: string;
    try {
      realRoot = fs.realpathSync(root);
      real = fs.realpathSync(absolute);
    } catch {
      return false;
    }
    return real === realRoot || real.startsWith(realRoot + path.sep);
  }

  /** Resolve, check existence before the real-path guard, and read. One of the three outcomes. */
  function readGuarded(action: string, requested: string): { body: string } | { refusal: ToolCallRecord } {
    let absolute: string;
    try {
      absolute = resolveBrainPath(options.profileDir, requested);
    } catch (err) {
      return { refusal: record(action, "blocked", `brain_read refused "${requested}": ${(err as Error).message}. Paths are relative to the brain root.`) };
    }
    // Existence is checked BEFORE the real-path guard, so "there is no such note" reads as a
    // miss rather than as a refusal: a model told it was blocked would go looking for a way in.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return { refusal: record(action, "failed", `brain_read: there is no file at "${requested}". The brain file tree in your prompt lists what there is.`) };
    }
    if (!insideBrain(absolute)) {
      return { refusal: record(action, "blocked", `brain_read refused "${requested}": it resolves outside the brain directory.`) };
    }
    if (!stat.isFile()) return { refusal: record(action, "failed", `brain_read: "${requested}" is a directory, not a file.`) };
    try {
      return { body: fs.readFileSync(absolute, "utf8") };
    } catch (err) {
      return { refusal: record(action, "failed", `brain_read could not read "${requested}": ${(err as Error).message}`) };
    }
  }

  function readChunk(action: string, id: string): ToolCallRecord {
    const parsed = parseChunkId(id);
    if (parsed === undefined) return record(action, "failed", `brain_read: "${id}" is not a chunk id; a chunk id looks like lease#7 or memory/2026-09-18.md#2.`);
    const relativePath = pathForChunkHead(parsed.head);
    const read = readGuarded(action, relativePath);
    if ("refusal" in read) return read.refusal;
    const file = chunkBrainFile(relativePath, read.body);
    const chunk = file.chunks[parsed.n - 1];
    if (chunk === undefined) {
      return record(action, "failed", `brain_read: ${relativePath} has ${String(file.chunks.length)} chunk(s); "${id}" names one that does not exist.`);
    }
    const title = file.title ?? relativePath;
    const citation = brainCitation({ id: chunk.id, path: relativePath, title, ...(chunk.page === undefined ? {} : { page: chunk.page }), ...(chunk.sheet === undefined ? {} : { sheet: chunk.sheet }) });
    const before = file.chunks[parsed.n - 2];
    const after = file.chunks[parsed.n];
    const sections = [
      `# ${chunk.id} (${title}${chunk.heading === undefined ? "" : ` > ${chunk.heading}`}) - cite as ${citation}`,
      ...(before === undefined ? [] : [renderChunk(before, " (before)")]),
      renderChunk(chunk, ""),
      ...(after === undefined ? [] : [renderChunk(after, " (after)")]),
    ];
    return record(action, "completed", sections.join("\n\n"));
  }

  return {
    name: BRAIN_READ_ADAPTER_NAME,
    scopes: [BRAIN_READ_ADAPTER_NAME, "brain:read", "memory:read"],
    availability: "real",
    instructions: renderToolInstructions(BRAIN_READ_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    async cleanup() {},

    async execute(action) {
      const { args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const requested = typeof args.path === "string" ? args.path.trim() : "";
      if (id !== "") return readChunk(action, id);
      if (requested === "") return record(action, "failed", 'brain_read requires "path" (a path from the brain file tree) or "id" (a chunk id from a brain recall line).');
      // A path with a chunk suffix (`docs/lease.md#3`) is a chunk id spelled the long way.
      if (parseChunkId(requested) !== undefined) return readChunk(action, requested);

      const read = readGuarded(action, requested);
      if ("refusal" in read) return read.refusal;
      const body = read.body;
      const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n... (${String(body.length - maxChars)} more characters in the file)` : body;
      return record(action, "completed", `# ${requested}\n\n${clipped}`);
    },

    async dryRun(action) {
      return record(action, "mocked", `brain_read dry-run: would read "${action}" from the brain (read-only).`);
    },
  };
}
