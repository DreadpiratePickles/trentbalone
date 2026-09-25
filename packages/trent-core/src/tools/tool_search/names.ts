/**
 * The disclosure bridge's own names, in a leaf module. `tool-names.ts` reads them to reserve them,
 * and `index.ts` reads `tool-names.ts` to tell Trent's tools from foreign ones, so they cannot live
 * in `index.ts` without an import cycle.
 */
export const TOOL_BRIDGE_ADAPTER_NAME = "tools";
export const TOOL_SEARCH_TOOL = "tool_search";
export const TOOL_DESCRIBE_TOOL = "tool_describe";
export const TOOL_CALL_TOOL = "tool_call";
export const TOOL_BRIDGE_SCOPES = [TOOL_BRIDGE_ADAPTER_NAME, TOOL_SEARCH_TOOL, TOOL_DESCRIBE_TOOL, TOOL_CALL_TOOL];
