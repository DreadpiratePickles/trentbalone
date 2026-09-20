/**
 * U5 — one JSON schema per Trent tool, read back from what the adapters publish.
 *
 * Every toolset renders its schemas into the seat's instructions through ONE function,
 * `renderToolInstructions` (`tools/web/schemas.ts`), and disclosure already splits that text back
 * into one block per tool (`parseToolBlocks`). `parseInstructionBlock` is the inverse of the
 * renderer: the block a seat reads becomes the `inputSchema` an MCP host reads, so both see the
 * same arguments, the same enums and the same required keys, and a description a human promoted
 * over the shipped one (`improve/tool-overrides.ts`) reaches the host too. Nothing here imports a
 * toolset's schema constant, which is what keeps MCP-discovered and plugin tools on the same path.
 *
 * Two toolsets describe themselves in prose rather than blocks: `file_ops` and `terminal`. Their
 * tables are here, keyed by the tool names those adapters answer to, and a test holds them to
 * `BUILTIN_TOOLS_BY_TOOLSET` so a tool added to either adapter cannot be silently unlisted.
 */
import type { ToolSchema } from "../tools/web/schemas.js";

/** The property line the renderer writes: `    key (type[, required])[ one of a|b][: description]`. */
const PROPERTY_LINE = /^ {4}(\S+) \(([A-Za-z]+)(, required)?\)(?: one of ([^:]+?))?(?:: (.*))?$/;
const ACTION_LINE = /^ {2}action = "/;
const HEAD_LINE = /^([A-Za-z][A-Za-z0-9_]*): (.*)$/;

interface Property {
  type?: string;
  enum?: string[];
  description?: string;
}

function property(type: string, enumeration: string | undefined, description: string | undefined): Property {
  const out: Property = {};
  if (type !== "any") out.type = type;
  if (enumeration !== undefined) out.enum = enumeration.split("|");
  if (description !== undefined && description !== "") out.description = description;
  return out;
}

/**
 * The schema a rendered block describes, or undefined when `block` is not a rendered block (prose
 * instructions, or a block for a different tool): a guess would advertise arguments the tool does
 * not take.
 */
export function parseInstructionBlock(block: string, name: string): ToolSchema | undefined {
  const lines = block.split("\n");
  const head = HEAD_LINE.exec(lines[0] ?? "");
  if (!head || head[1] !== name) return undefined;
  const actionAt = lines.findIndex((line) => ACTION_LINE.test(line));
  if (actionAt === -1) return undefined;
  // The description runs to the `action =` line; the renderer never breaks it, but a promoted
  // description may carry a newline and still belongs to this tool.
  const description = [head[2] ?? "", ...lines.slice(1, actionAt)].join("\n").trim();
  const properties: Record<string, Property> = {};
  const required: string[] = [];
  let last: string | undefined;
  for (const line of lines.slice(actionAt + 1)) {
    const match = PROPERTY_LINE.exec(line);
    if (match) {
      const [, key, type, isRequired, enumeration, text] = match;
      properties[key!] = property(type!, enumeration, text);
      if (isRequired) required.push(key!);
      last = key;
      continue;
    }
    // A continuation line belongs to the previous property's description.
    if (last !== undefined && line.trim() !== "") {
      const current = properties[last]!;
      current.description = `${current.description ?? ""}\n${line.trim()}`.trim();
    }
  }
  return { name, description, parameters: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

/**
 * `file_ops` and `terminal` teach the seat by example (`FILE_OPS_INSTRUCTIONS`,
 * `TERMINAL_INSTRUCTIONS`); these are those examples as schemas. Descriptions say what the
 * adapter does with the key, not what a host should think of it.
 */
export const PROSE_TOOL_SCHEMAS: Readonly<Record<string, ToolSchema>> = {
  read_file: {
    name: "read_file",
    description: "Read a file in the workspace as numbered lines; page with offset and limit (next_offset in the result).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "integer", description: "First line to return (1-based)." },
        limit: { type: "integer", description: "Maximum lines to return." },
      },
      required: ["path"],
    },
  },
  write_file: {
    name: "write_file",
    description: "Create or replace a file in the workspace with the given content. Requires approval unless writes are auto-approved.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "The whole file content." },
      },
      required: ["path", "content"],
    },
  },
  patch: {
    name: "patch",
    description: "Replace one exact occurrence of old_string with new_string in a workspace file (every occurrence with replace_all).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        old_string: { type: "string", description: "Exact existing text." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  search_files: {
    name: "search_files",
    description: "Search file contents or file names in the workspace with a regex or glob.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A regex (content) or a glob (files)." },
        target: { type: "string", enum: ["content", "files"], description: "What to search." },
        path: { type: "string", description: "Directory to search, relative to the workspace root." },
        file_glob: { type: "string", description: "Only files matching this glob." },
        limit: { type: "integer", description: "Maximum matches to return." },
      },
      required: ["pattern"],
    },
  },
  terminal: {
    name: "terminal",
    description: "Run a shell command in the isolated sandbox with the workspace mounted at /workspace; the working directory persists between calls.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command." },
        timeout: { type: "integer", description: "Seconds before the command is killed." },
        workdir: { type: "string", description: "Working directory inside the sandbox." },
        background: { type: "boolean", description: "Start the command as a background session." },
      },
      required: ["command"],
    },
  },
  process_manage: {
    name: "process_manage",
    description: "List, poll, read the log of, wait for or kill a background terminal session.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "poll", "log", "wait", "kill"], description: "What to do." },
        session_id: { type: "string", description: "The background session id." },
        timeout: { type: "integer", description: "Seconds to wait." },
      },
      required: ["action"],
    },
  },
};

/** The `inputSchema` field of an MCP tool: the JSON schema object, `required` only when non-empty. */
export function toolInputSchema(schema: ToolSchema): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  const required = schema.parameters.required ?? [];
  return { type: "object", properties: { ...schema.parameters.properties }, ...(required.length ? { required: [...required] } : {}) };
}
