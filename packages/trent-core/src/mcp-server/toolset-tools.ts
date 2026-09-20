/**
 * U5 — the MCP tool names `trent mcp serve` exposes per toolset, as data.
 *
 * `fleet export --target claude` writes a subagent's `tools:` line without building a runtime
 * (no proxy, no sandbox, no docker probe), so it needs the catalog's names statically. They are
 * read from the same schema constants the adapters render, and `toolset-tools.test.ts` holds the
 * table to a live `buildToolCatalog` over built adapters, so the two cannot drift silently. Tools a
 * server discovers at run time (a configured MCP server's tools, a plugin's tools) are not here;
 * the host learns them from `tools/list`.
 */
import type { Toolset } from "../config/schema.js";
import { FLEET_SEARCH_TOOL_SCHEMAS } from "../fleet-memory/search.js";
import { BROWSER_TOOL_SCHEMAS } from "../tools/browser/index.js";
import { CODE_EXECUTION_SCHEMAS } from "../tools/code_execution/schemas.js";
import { CRON_TOOL_SCHEMAS } from "../tools/cron/index.js";
import { DELEGATE_TOOL_SCHEMAS } from "../tools/delegate/index.js";
import { MCP_STATUS_TOOL } from "../tools/mcp/index.js";
import { MEDIA_TOOL_SCHEMAS } from "../tools/media/schemas.js";
import { BRAIN_READ_TOOL_SCHEMAS } from "../tools/memory/brain-read.js";
import { MEMORY_TOOL_SCHEMAS } from "../tools/memory/index.js";
import { PLUGINS_LIST_TOOL } from "../tools/plugins/index.js";
import { SESSION_SEARCH_TOOL_SCHEMAS } from "../tools/session_search/index.js";
import { SKILL_TOOL_SCHEMAS } from "../tools/skills/index.js";
import { TODO_TOOL_SCHEMAS } from "../tools/todo/index.js";
import { VISION_TOOL_SCHEMAS } from "../tools/vision/index.js";
import { WEB_TOOL_SCHEMAS } from "../tools/web/schemas.js";
import type { ToolSchema } from "../tools/web/schemas.js";
import { PROSE_TOOL_SCHEMAS } from "./schemas.js";

const names = (schemas: readonly ToolSchema[]): string[] => schemas.map((schema) => schema.name);

/** Tool names per toolset. `human` is empty because the server does not expose the founder prompt. */
export const MCP_TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly string[]>> = {
  file_ops: ["read_file", "write_file", "patch", "search_files"].filter((name) => name in PROSE_TOOL_SCHEMAS),
  terminal: ["terminal", "process_manage"].filter((name) => name in PROSE_TOOL_SCHEMAS),
  web: names(WEB_TOOL_SCHEMAS),
  code: names(CODE_EXECUTION_SCHEMAS),
  delegation: names(DELEGATE_TOOL_SCHEMAS),
  cron: names(CRON_TOOL_SCHEMAS),
  skills: names(SKILL_TOOL_SCHEMAS),
  plugins: [PLUGINS_LIST_TOOL],
  browser: names(BROWSER_TOOL_SCHEMAS),
  vision: names(VISION_TOOL_SCHEMAS),
  mcp: [MCP_STATUS_TOOL],
  human: [],
  media: names(MEDIA_TOOL_SCHEMAS),
  memory: [...names(MEMORY_TOOL_SCHEMAS), ...names(FLEET_SEARCH_TOOL_SCHEMAS), ...names(BRAIN_READ_TOOL_SCHEMAS)],
};

/** Registered on every build whatever the toolsets (`ALWAYS_ON_ADAPTERS`), minus the founder card. */
export const MCP_ALWAYS_ON_TOOLS: readonly string[] = [...names(TODO_TOOL_SCHEMAS), ...names(SESSION_SEARCH_TOOL_SCHEMAS)];

/** The sorted, de-duplicated tool names a host sees for these toolsets. */
export function mcpToolNamesFor(toolsets: readonly string[]): string[] {
  const out = new Set<string>(MCP_ALWAYS_ON_TOOLS);
  for (const toolset of toolsets) for (const name of MCP_TOOLS_BY_TOOLSET[toolset as Toolset] ?? []) out.add(name);
  return [...out].sort();
}
