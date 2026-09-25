/**
 * Every tool name Trent's own toolsets answer to, plus the adapter names the read-only app
 * registers. `plugins` refuses a manifest whose tool would shadow any of these, so a third-party
 * `plugin.json` can never take over `terminal`, `social_post` or `brain_read`; disclosure reads the
 * same list to tell Trent's own tools from foreign ones.
 *
 * DERIVED, never typed: each entry is read from the constants its adapter registers (its scopes, or
 * its adapter name plus its schema names), so a tool added to a toolset is reserved the moment it
 * exists. The hand-kept list this replaces had no `social` entry and missed `brain_read` and
 * `fleet_skill_view` (scorecard 2026-09-25, retraction 7). `tool-names.test.ts` builds every adapter
 * Trent registers and holds this table to what they really answer to, in both directions.
 *
 * Each import is the lightest module that owns the constant. The two toolsets whose `index.ts`
 * imports this file (`plugins` through its manifest check, `tool_search` for disclosure) keep their
 * names in a leaf `names.ts`, so there is no import cycle.
 */
import { FLEET_SEARCH_ADAPTER_NAME, FLEET_SEARCH_TOOL_SCHEMAS } from "../fleet-memory/search.js";
import { BROWSER_ADAPTER_NAME } from "./browser/index.js";
import { BROWSER_TOOL_SCHEMAS } from "./browser/schemas.js";
import { BUSINESS_ADAPTER_NAME, BUSINESS_TOOL_NAMES } from "./business/schemas.js";
import { CLARIFY_SCOPES } from "./clarify/index.js";
import { CODE_EXECUTION_SCOPES } from "./code_execution/index.js";
import { CRON_ADAPTER_NAME, CRON_TOOL_SCHEMAS } from "./cron/index.js";
import { DELEGATE_SCOPES } from "./delegate/index.js";
import { FILE_OPS_SCOPES } from "./file_ops/adapter.js";
import { HUMAN_SCOPES } from "./human/index.js";
import { MCP_ADAPTER_NAME, MCP_STATUS_TOOL } from "./mcp/index.js";
import { MEDIA_ADAPTER_NAME, MEDIA_TOOL_NAMES } from "./media/schemas.js";
import { BRAIN_READ_ADAPTER_NAME, BRAIN_READ_TOOL_SCHEMAS } from "./memory/brain-read.js";
import { MEMORY_ADAPTER_NAME, MEMORY_TOOL_SCHEMAS } from "./memory/index.js";
import { PLUGINS_ADAPTER_NAME, PLUGINS_LIST_TOOL } from "./plugins/names.js";
import { SESSION_SEARCH_SCOPES } from "./session_search/index.js";
import { SKILLS_ADAPTER_NAME } from "./skills/index.js";
import { SKILL_TOOL_SCHEMAS } from "./skills/schemas.js";
import { SOCIAL_ADAPTER_NAME, SOCIAL_TOOL_NAMES } from "./social/schemas.js";
import { TERMINAL_SCOPES } from "./terminal/adapter.js";
import { TODO_SCOPES } from "./todo/index.js";
import { TOOL_BRIDGE_SCOPES } from "./tool_search/names.js";
import { VISION_ADAPTER_NAME, VISION_TOOL_SCHEMAS } from "./vision/index.js";
import { WEB_ADAPTER_NAME } from "./web/index.js";
import { WEB_TOOL_SCHEMAS, type ToolSchema } from "./web/schemas.js";

/** An adapter's name first, then every tool it renders a schema for; duplicates dropped. */
function family(adapter: string, ...tools: readonly (readonly string[])[]): readonly string[] {
  return [...new Set([adapter, ...tools.flat()])];
}

const names = (schemas: readonly ToolSchema[]): readonly string[] => schemas.map((schema) => schema.name);

/** Hermes toolset -> the tool names it exposes, as Trent implements them. */
export const BUILTIN_TOOLS_BY_TOOLSET: Readonly<Record<string, readonly string[]>> = {
  file_ops: [...FILE_OPS_SCOPES],
  terminal: [...TERMINAL_SCOPES],
  web: family(WEB_ADAPTER_NAME, names(WEB_TOOL_SCHEMAS)),
  // The fleet-memory hook registers three adapters for the `memory` toolset: the blocks, the
  // cross-seat search with its shared-skill view, and the brain reader.
  memory: [
    ...family(MEMORY_ADAPTER_NAME, names(MEMORY_TOOL_SCHEMAS)),
    ...family(FLEET_SEARCH_ADAPTER_NAME, names(FLEET_SEARCH_TOOL_SCHEMAS)),
    ...family(BRAIN_READ_ADAPTER_NAME, names(BRAIN_READ_TOOL_SCHEMAS)),
  ],
  skills: family(SKILLS_ADAPTER_NAME, names(SKILL_TOOL_SCHEMAS)),
  cron: family(CRON_ADAPTER_NAME, names(CRON_TOOL_SCHEMAS)),
  code_execution: [...CODE_EXECUTION_SCOPES],
  delegation: [...DELEGATE_SCOPES],
  plugins: family(PLUGINS_ADAPTER_NAME, [PLUGINS_LIST_TOOL]),
  browser: family(BROWSER_ADAPTER_NAME, names(BROWSER_TOOL_SCHEMAS)),
  vision: family(VISION_ADAPTER_NAME, names(VISION_TOOL_SCHEMAS)),
  mcp: family(MCP_ADAPTER_NAME, [MCP_STATUS_TOOL]),
  human: [...HUMAN_SCOPES],
  media: family(MEDIA_ADAPTER_NAME, MEDIA_TOOL_NAMES),
  social: family(SOCIAL_ADAPTER_NAME, SOCIAL_TOOL_NAMES),
  business: family(BUSINESS_ADAPTER_NAME, BUSINESS_TOOL_NAMES),
  // A3. The disclosure bridges. `tools` is the bridge adapter's own name; a plugin that tried to
  // claim it would be claiming the way out of the deferred set, which is exactly what the
  // reservation is for.
  tools: [...TOOL_BRIDGE_SCOPES],
  todo: [...TODO_SCOPES],
  clarify: [...CLARIFY_SCOPES],
  session_search: [...SESSION_SEARCH_SCOPES],
};

/**
 * Adapter names owned by `apps/web/lib/tools.ts`; also reserved. Data rather than an import,
 * because `apps/web` is read-only and importing it loads the application; `tool-names.test.ts`
 * reads that file and fails when the two disagree.
 */
export const APP_ADAPTER_NAMES: readonly string[] = ["GitHub", "Steel Browser", "Camofox"];

export const BUILTIN_TOOL_NAMES: readonly string[] = [
  ...new Set([...Object.values(BUILTIN_TOOLS_BY_TOOLSET).flat(), ...APP_ADAPTER_NAMES]),
];

export function isBuiltinToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return BUILTIN_TOOL_NAMES.some((builtin) => builtin.toLowerCase() === lower);
}
