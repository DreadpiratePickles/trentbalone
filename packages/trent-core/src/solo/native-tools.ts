/**
 * [CF] C14.1: the tools a solo request offers NATIVELY, on the one route that takes them.
 *
 * The gateway sends a request's `tools` to Anthropic as native schemas (`model-gateway/anthropic-client.ts`, C14)
 * and a text route ignores them; `solo/parse.ts` turns each `tool_use` back into the same `<tool> <json>` action a
 * `<tool_call>` body produces (C14 step 4). What was missing is the list itself. The runner holds ADAPTERS, not the
 * toolsets' `*_TOOL_SCHEMAS`, so the schemas are read back from what each adapter publishes, by the inverse the MCP
 * catalog already uses (`mcp-server/catalog.ts` `schemaFor`): the adapter's rendered block for each tool name
 * (`parseToolBlocks` + `parseInstructionBlock`), and for `file_ops` and `terminal`, which teach by example, the
 * catalog's prose table (`PROSE_TOOL_SCHEMAS`). Two differences from the catalog, both solo's:
 *   - the text read is the adapter's SOLO text (`soloTextOf`: `memory` offers replace and remove in solo), and a
 *     description says "person" where the fleet's says "founder" (`soloWording`), as the prompt's disclosure does;
 *   - nothing is left out by name: `ask_human`, `clarify` and the disclosure bridge's own tools are solo's to call.
 * A tool whose adapter publishes no parsable schema is simply not offered natively; the prompt still teaches it
 * and the text protocol still runs it. Deferred tools stay behind `tool_search`: they are in no adapter's scopes.
 *
 * Only `anthropic` (as configured, or an alias that resolves to it; none does today) gets them: every other route
 * is text-only for tools, and a local model keeps the text protocol and constrained output (C11).
 */
import { PROSE_TOOL_SCHEMAS, parseInstructionBlock } from "../mcp-server/schemas.js";
import { resolveProviderAlias } from "../model-gateway/providers.js";
import type { GatewayToolDefinition } from "../model-gateway/types.js";
import { parseToolBlocks } from "../tools/tool_search/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import type { ToolSchema } from "../tools/web/schemas.js";
import { soloTextOf, soloWording } from "./prompt.js";

/** Adapters that describe their tools in prose, whose schemas are the catalog's table (`mcp-server/schemas.ts`). */
const PROSE_ADAPTERS: readonly string[] = ["file_ops", "terminal"];

/** True when a request routed to `provider` (a `ModelProvider` or an alias) can carry native tools. */
export function offersNativeTools(provider: string | undefined): boolean {
  if (provider === undefined || provider.trim() === "") return false;
  return (resolveProviderAlias(provider)?.provider ?? provider.trim().toLowerCase()) === "anthropic";
}

function schemaOf(adapter: TrentToolAdapter, name: string, blocks: ReadonlyMap<string, string>): ToolSchema | undefined {
  const block = blocks.get(name);
  const parsed = block === undefined ? undefined : parseInstructionBlock(block, name);
  if (parsed !== undefined) return parsed;
  return PROSE_ADAPTERS.includes(adapter.name) ? PROSE_TOOL_SCHEMAS[name] : undefined;
}

/** A schema's descriptions, its own and each argument's, in solo's words. */
function inSoloWords(schema: ToolSchema): GatewayToolDefinition {
  const properties = Object.fromEntries(
    Object.entries(schema.parameters.properties).map(([key, value]) => {
      const property = value as { readonly description?: unknown };
      return [key, typeof property.description === "string" ? { ...property, description: soloWording(property.description) } : value];
    }),
  );
  return { name: schema.name, description: soloWording(schema.description), parameters: { ...schema.parameters, properties } };
}

/** The native tool list for these adapters, in build order; a name offered twice keeps its first adapter. */
export function soloNativeTools(adapters: readonly TrentToolAdapter[]): GatewayToolDefinition[] {
  const out: GatewayToolDefinition[] = [];
  const seen = new Set<string>();
  for (const adapter of adapters) {
    const names = [...new Set(adapter.scopes.filter((scope) => !scope.includes(":")))];
    const blocks = parseToolBlocks(soloTextOf(adapter), names);
    for (const name of names) {
      if (seen.has(name)) continue;
      const schema = schemaOf(adapter, name, blocks);
      if (schema === undefined) continue;
      seen.add(name);
      out.push(inSoloWords(schema));
    }
  }
  return out;
}
