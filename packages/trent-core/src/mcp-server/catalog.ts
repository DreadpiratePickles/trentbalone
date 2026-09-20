/**
 * U5 — the catalog `trent mcp serve` publishes: one MCP tool per callable Trent tool, derived
 * from the adapters `buildTrentTools` returned and nothing else.
 *
 * Advertised tools come off each adapter's own `scopes` and `instructions`; deferred ones (the
 * names disclosure masked past `tools.disclosure_threshold`, and every MCP or plugin tool) come
 * off the bridge's `deferred()` listing and are CALLED through the bridge's `tool_call`, so a
 * call from a host re-enters the same autonomy, policy, idempotency and hook chain a seat's
 * `tool_call` enters. A tool with no schema anywhere is not listed: a host that is shown
 * arguments a tool does not take has been lied to.
 *
 * Left out, by name: the bridge's own three tools (this catalog IS the listing they exist to
 * avoid), and `ask_human` / `clarify`, whose answers arrive through a Trent surface the host does
 * not have; the host agent asks its own user.
 */
import { parseToolBlocks, isToolBridge, TOOL_BRIDGE_ADAPTER_NAME, type ToolBridgeAdapter } from "../tools/tool_search/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import type { ToolSchema } from "../tools/web/schemas.js";
import { PROSE_TOOL_SCHEMAS, parseInstructionBlock, toolInputSchema } from "./schemas.js";

/** Adapters whose tools never reach a host, with the reason a reader of `docs/mcp.md` gets. */
export const EXCLUDED_ADAPTERS: readonly string[] = [TOOL_BRIDGE_ADAPTER_NAME, "human", "clarify"];

export interface McpInputSchema {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: string[];
}

/** One MCP tool and the Trent adapter that answers it. */
export interface TrentMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpInputSchema;
  /** The Trent adapter (toolset) that owns the tool. */
  readonly adapter: string;
  /** `direct`: `target.execute("<name> <json>")`. `bridge`: `target` is the bridge, called with `tool_call`. */
  readonly via: "direct" | "bridge";
  readonly target: TrentToolAdapter;
}

/** Tool names an adapter advertises: its scopes minus the colon-qualified permission scopes. */
function advertisedNames(adapter: TrentToolAdapter): string[] {
  return [...new Set(adapter.scopes.filter((scope) => !scope.includes(":")))];
}

function schemaFor(adapter: TrentToolAdapter, name: string, blocks: Map<string, string>): ToolSchema | undefined {
  const block = blocks.get(name);
  const parsed = block === undefined ? undefined : parseInstructionBlock(block, name);
  if (parsed !== undefined) return parsed;
  const prose = PROSE_TOOL_SCHEMAS[name];
  return prose !== undefined && (adapter.name === "file_ops" || adapter.name === "terminal") ? prose : undefined;
}

function entry(schema: ToolSchema, adapter: string, via: TrentMcpTool["via"], target: TrentToolAdapter): TrentMcpTool {
  return { name: schema.name, description: schema.description, inputSchema: toolInputSchema(schema), adapter, via, target };
}

/**
 * The catalog for one built adapter list. Order: adapters in build order, each adapter's tools in
 * scope order, then the deferred tools in the bridge's order; a name that appears twice keeps its
 * first entry, which is the advertised one.
 */
export function buildToolCatalog(adapters: readonly TrentToolAdapter[]): TrentMcpTool[] {
  const out: TrentMcpTool[] = [];
  const seen = new Set<string>();
  let bridge: ToolBridgeAdapter | undefined;
  for (const adapter of adapters) {
    if (isToolBridge(adapter)) {
      bridge = adapter;
      continue;
    }
    if (EXCLUDED_ADAPTERS.includes(adapter.name)) continue;
    const names = advertisedNames(adapter);
    const blocks = parseToolBlocks(adapter.instructions, names);
    for (const name of names) {
      if (seen.has(name)) continue;
      const schema = schemaFor(adapter, name, blocks);
      if (schema === undefined) continue;
      seen.add(name);
      out.push(entry(schema, adapter.name, "direct", adapter));
    }
  }
  if (bridge !== undefined) {
    for (const deferred of bridge.deferred()) {
      if (seen.has(deferred.name) || EXCLUDED_ADAPTERS.includes(deferred.adapter)) continue;
      const schema = deferred.schema === undefined ? undefined : parseInstructionBlock(deferred.schema, deferred.name);
      if (schema === undefined) continue;
      seen.add(deferred.name);
      out.push(entry(schema, deferred.adapter, "bridge", bridge));
    }
  }
  return out;
}

/** The catalog narrowed to the adapters of the given toolsets, for a seat-shaped export. */
export function catalogToolNames(catalog: readonly TrentMcpTool[], adapters?: ReadonlySet<string>): string[] {
  return catalog.filter((tool) => adapters === undefined || adapters.has(tool.adapter)).map((tool) => tool.name);
}
