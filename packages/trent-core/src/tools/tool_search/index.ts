/**
 * A3 — progressive tool disclosure: `tool_search`, `tool_describe`, `tool_call`.
 *
 * Hermes principle 10 (`01_discovery/output/hermes-feature-inventory-2026-09.md` §4): a catalog
 * costs almost no context until something in it is needed. Trent rendered every registered tool's
 * schema into every seat prompt, so one MCP server with forty tools taxed every turn of every seat
 * whether or not a connector was ever touched.
 *
 * What is deferred:
 *   - every MCP, plugin and app-catalog tool, whatever the count: these arrive from outside, their
 *     descriptions are written by someone else, and their number is not ours to bound;
 *   - everything outside {@link CORE_ADAPTERS} once the registered tool count passes
 *     `tools.disclosure_threshold`.
 * A deferred tool keeps its adapter registered — only its NAME leaves the advertised list and its
 * schema leaves the prompt.
 *
 * What is NOT deferred is the gate chain. `tool_call` composes the same `"<tool> <json>"` action a
 * direct call composes and hands it to the SAME wrapped adapter (`buildTrentTools` wraps first,
 * discloses second), so autonomy, the hardline blocklist, `approvals.deny`, the approval floors,
 * the policy rules, idempotency and the user hooks all fire exactly as they would have. Routing
 * around the advertised list buys context, never permission.
 */
import { record as toRecord, type ToolSpec } from "../action.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { isBuiltinToolName } from "../tool-names.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { rankDocuments } from "./rank.js";

export { rankDocuments, tokenize, type RankableDocument, type RankedDocument } from "./rank.js";

export const TOOL_BRIDGE_ADAPTER_NAME = "tools";
export const TOOL_SEARCH_TOOL = "tool_search";
export const TOOL_DESCRIBE_TOOL = "tool_describe";
export const TOOL_CALL_TOOL = "tool_call";
export const TOOL_BRIDGE_SCOPES = [TOOL_BRIDGE_ADAPTER_NAME, TOOL_SEARCH_TOOL, TOOL_DESCRIBE_TOOL, TOOL_CALL_TOOL];

/** Mirrors `config.tools.disclosure_threshold`; `config/schema.ts` holds the same number. */
export const DEFAULT_DISCLOSURE_THRESHOLD = 24;

/**
 * Adapters whose tools stay advertised at every catalog size: the seat's own hands, its memory,
 * the founder prompt, and the three planning tools a turn uses before it uses anything else.
 * Hiding these behind a search would cost a round trip on the calls every single turn makes.
 */
export const CORE_ADAPTERS: readonly string[] = [
  "file_ops",
  "human",
  "memory",
  "fleet_search",
  "todo",
  "clarify",
  "session_search",
  TOOL_BRIDGE_ADAPTER_NAME,
];

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 40;
const DESCRIPTION_CHARS = 200;

export const TOOL_BRIDGE_SCHEMAS: ToolSchema[] = [
  {
    name: TOOL_SEARCH_TOOL,
    description:
      "Find a tool that is registered but not listed in your instructions. Ranks every deferred " +
      "tool by name and description and returns the best matches with one line each. Read-only.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the tool would do, in your own words." },
        limit: { type: "integer", description: `Maximum matches to return (1-${SEARCH_MAX_LIMIT}, default ${SEARCH_DEFAULT_LIMIT}).` },
      },
      required: ["query"],
    },
  },
  {
    name: TOOL_DESCRIBE_TOOL,
    description: "Return the full schema of one tool by name: its description and every argument it takes. Read-only.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: `The exact tool name, as ${TOOL_SEARCH_TOOL} printed it.` } },
      required: ["name"],
    },
  },
  {
    name: TOOL_CALL_TOOL,
    description:
      "Call a tool by name with its arguments. It runs through exactly the gates a directly " +
      "advertised call runs through: approvals, the blocklist and your hooks all still apply.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The exact tool name." },
        arguments: { type: "object", description: "The tool's arguments, as its schema describes them." },
      },
      required: ["name", "arguments"],
    },
  },
];

const BRIDGE_SPECS: readonly ToolSpec[] = [
  { name: TOOL_SEARCH_TOOL, primary: "query", signature: ["query"] },
  { name: TOOL_DESCRIBE_TOOL, primary: "name", signature: ["name"] },
  { name: TOOL_CALL_TOOL, primary: "name", signature: ["name", "arguments"] },
];

const ROUTING_TEXT =
  "find a tool, search the tool catalog, list available integrations, describe a tool's arguments, " +
  "call a connector tool by name, MCP and plugin tools that are not listed";

/** One tool the seat can reach but cannot see, and where its schema came from. */
export interface DeferredTool {
  readonly name: string;
  readonly adapter: string;
  readonly description: string;
  /** The rendered schema block `tool_describe` returns, when the owning adapter published one. */
  readonly schema: string | undefined;
}

export interface DisclosureOptions {
  readonly threshold?: number;
  /**
   * Configured MCP servers. Discovery is asynchronous (`tools/mcp/index.ts` returns before
   * `tools/list` answers), so the presence of a server — not the tools it has yet to report — is
   * what decides whether the bridges are registered at build time.
   */
  readonly mcpServers?: Readonly<Record<string, unknown>>;
}

/** An adapter no toolset claims is an app-catalog or caller-registered adapter. */
export type ToolsetLookup = Readonly<Record<string, string>>;

function toolNamesOf(adapter: TrentToolAdapter): string[] {
  return [...new Set(adapter.scopes.filter((scope) => !scope.includes(":")))];
}

function isCore(adapter: TrentToolAdapter): boolean {
  return CORE_ADAPTERS.includes(adapter.name);
}

/**
 * Splits a rendered instruction block (`renderToolInstructions`) back into one block per tool.
 * Every toolset in this package renders through that one function, so the shape is known: a block
 * opens on a line `"<name>: <description>"` and runs to the next such line.
 */
export function parseToolBlocks(instructions: string, names: readonly string[]): Map<string, string> {
  const wanted = new Set(names);
  const blocks = new Map<string, string>();
  let current: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (current !== undefined) blocks.set(current, lines.join("\n").trimEnd());
    current = undefined;
    lines = [];
  };
  for (const line of instructions.split("\n")) {
    const head = /^([A-Za-z][A-Za-z0-9_]*):\s/.exec(line);
    if (head && wanted.has(head[1]!)) {
      flush();
      current = head[1]!;
    }
    if (current !== undefined) lines.push(line);
  }
  flush();
  return blocks;
}

function describeFrom(block: string | undefined, name: string): string {
  if (block === undefined) return "";
  const first = block.split("\n")[0] ?? "";
  return first.slice(name.length + 1).trim();
}

/** The predicate, live: MCP discovery finishes after the build, so nothing here is precomputed. */
class Disclosure {
  readonly #adapters: readonly TrentToolAdapter[];
  readonly #threshold: number;
  readonly #toolsets: ToolsetLookup;

  constructor(adapters: readonly TrentToolAdapter[], toolsets: ToolsetLookup, threshold: number) {
    this.#adapters = adapters;
    this.#threshold = threshold;
    this.#toolsets = toolsets;
  }

  /** The same policy over a subset, so a seat's bridge never searches tools that seat cannot use. */
  forAdapters(adapters: readonly TrentToolAdapter[]): Disclosure {
    return new Disclosure(adapters, this.#toolsets, this.#threshold);
  }

  /** A tool the wrapper did not name itself: an MCP tool, a plugin tool, or an app-catalog one. */
  #foreign(adapter: TrentToolAdapter, tool: string): boolean {
    if (this.#toolsets[adapter.name] === undefined && !isCore(adapter)) return true;
    return !isBuiltinToolName(tool);
  }

  #total(): number {
    return this.#adapters.reduce((sum, adapter) => sum + toolNamesOf(adapter).length, 0);
  }

  isDeferred(adapter: TrentToolAdapter, tool: string): boolean {
    if (tool === adapter.name && !this.#foreign(adapter, tool)) return false;
    if (this.#foreign(adapter, tool)) return true;
    return !isCore(adapter) && this.#total() > this.#threshold;
  }

  deferred(): DeferredTool[] {
    const out: DeferredTool[] = [];
    for (const adapter of this.#adapters) {
      const names = toolNamesOf(adapter).filter((tool) => this.isDeferred(adapter, tool));
      if (names.length === 0) continue;
      const blocks = parseToolBlocks(adapter.instructions, names);
      for (const name of names) {
        const block = blocks.get(name);
        out.push({ name, adapter: adapter.name, description: describeFrom(block, name), schema: block });
      }
    }
    return out;
  }
}

/** Every tool name that is registered right now, whether advertised or deferred. */
function targetsOf(adapters: readonly TrentToolAdapter[]): Map<string, TrentToolAdapter> {
  const targets = new Map<string, TrentToolAdapter>();
  for (const adapter of adapters) {
    if (adapter.name === TOOL_BRIDGE_ADAPTER_NAME) continue;
    for (const name of [adapter.name, ...toolNamesOf(adapter)]) if (!targets.has(name)) targets.set(name, adapter);
  }
  return targets;
}

/** The record a caller gets for a name nothing answers to: typed, and it names the way forward. */
export interface UnknownToolRecord extends ToolCallRecord {
  readonly details: { readonly kind: "unknown_tool"; readonly name: string; readonly hint: string };
}

export interface ToolBridgeAdapter extends TrentToolAdapter {
  /** The same bridge over a subset of the adapters: how `adaptersForSeat` keeps the per-seat gate. */
  restrict(keep: (adapter: TrentToolAdapter) => boolean): ToolBridgeAdapter;
}

export function isToolBridge(adapter: TrentToolAdapter): adapter is ToolBridgeAdapter {
  return adapter.name === TOOL_BRIDGE_ADAPTER_NAME && typeof (adapter as ToolBridgeAdapter).restrict === "function";
}

function parseBridgeAction(action: string): { tool: string; args: Record<string, unknown>; error?: string } {
  const trimmed = action.trim();
  const brace = trimmed.indexOf("{");
  const head = (brace === -1 ? trimmed : trimmed.slice(0, brace)).trim();
  const tool = (head.split(/\s+/)[0] ?? "").toLowerCase();
  const known = BRIDGE_SPECS.find((spec) => spec.name === tool);
  if (!known) {
    return { tool, args: {}, error: `Unknown bridge tool "${tool}". Use one of: ${BRIDGE_SPECS.map((s) => s.name).join(", ")}.` };
  }
  if (brace === -1) {
    const rest = head.slice(tool.length).trim();
    return { tool: known.name, args: rest === "" ? {} : { [known.primary]: rest } };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(brace));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { tool: known.name, args: {}, error: `${known.name} takes a JSON object of arguments.` };
    }
    return { tool: known.name, args: parsed as Record<string, unknown> };
  } catch {
    return { tool: known.name, args: {}, error: `Malformed JSON in the ${known.name} action.` };
  }
}

function createBridge(adapters: readonly TrentToolAdapter[], disclosure: Disclosure): ToolBridgeAdapter {
  const record = (action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord =>
    toRecord(TOOL_BRIDGE_ADAPTER_NAME, action, status, summary);

  const unknown = (action: string, name: string): UnknownToolRecord => ({
    ...record(
      action,
      "failed",
      `No tool named "${name}" is registered. Run ${TOOL_SEARCH_TOOL} with what you need it to do, then ${TOOL_CALL_TOOL} the name it returns.`,
    ),
    details: { kind: "unknown_tool", name, hint: TOOL_SEARCH_TOOL },
  });

  const resolve = (args: Record<string, unknown>): { name: string; target?: TrentToolAdapter; action: string } => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const raw = args.arguments;
    const payload = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const target = targetsOf(adapters).get(name);
    return { name, ...(target ? { target } : {}), action: `${name} ${JSON.stringify(payload)}` };
  };

  const search = (action: string, args: Record<string, unknown>): ToolCallRecord => {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query === "") return record(action, "failed", `${TOOL_SEARCH_TOOL} needs a non-empty "query".`);
    const deferred = disclosure.deferred();
    const limitRaw = typeof args.limit === "number" ? args.limit : Number(args.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : SEARCH_DEFAULT_LIMIT;
    const ranked = rankDocuments(
      deferred.map((tool) => ({ id: tool.name, title: tool.name, body: tool.description })),
      query,
    ).slice(0, limit);
    if (ranked.length === 0) {
      return record(
        action,
        "completed",
        `No deferred tool matches "${query}". ${deferred.length} tool(s) are reachable through ${TOOL_CALL_TOOL}; try other words.`,
      );
    }
    const byName = new Map(deferred.map((tool) => [tool.name, tool]));
    const lines = ranked.map((hit) => {
      const tool = byName.get(hit.id)!;
      const description = tool.description.slice(0, DESCRIPTION_CHARS);
      return `${tool.name} [${tool.adapter}] ${description}`;
    });
    return record(action, "completed", [`${ranked.length} of ${deferred.length} tool(s) match "${query}":`, ...lines].join("\n"));
  };

  const describe = (action: string, args: Record<string, unknown>): ToolCallRecord => {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (name === "") return record(action, "failed", `${TOOL_DESCRIBE_TOOL} needs a non-empty "name".`);
    const tool = disclosure.deferred().find((entry) => entry.name === name);
    if (!tool) {
      const target = targetsOf(adapters).get(name);
      if (!target) return unknown(action, name);
      const block = parseToolBlocks(target.instructions, [name]).get(name);
      return record(action, "completed", block ?? `${name} is advertised by the ${target.name} toolset; its schema is already in your instructions.`);
    }
    return record(action, "completed", tool.schema ?? `${name} is registered by ${tool.adapter} and publishes no schema; call it with the arguments its server documents.`);
  };

  const bridge: ToolBridgeAdapter = {
    name: TOOL_BRIDGE_ADAPTER_NAME,
    scopes: [...TOOL_BRIDGE_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(TOOL_BRIDGE_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, args, error } = parseBridgeAction(action);
      if (error !== undefined || tool !== TOOL_CALL_TOOL) return false;
      const { target, action: composed } = resolve(args);
      return target === undefined ? false : target.requiresApproval(composed);
    },
    async dryRun(action, payload) {
      const { tool, args, error } = parseBridgeAction(action);
      if (error !== undefined) return record(action, "failed", error);
      if (tool === TOOL_SEARCH_TOOL) return search(action, args);
      if (tool === TOOL_DESCRIBE_TOOL) return describe(action, args);
      const { name, target, action: composed } = resolve(args);
      if (target === undefined) return unknown(action, name);
      if (target.dryRun) return target.dryRun(composed, payload);
      return toRecord(target.name, composed, "needs_approval", `${name} requires approval before it runs.`);
    },
    async execute(action, payload) {
      const { tool, args, error } = parseBridgeAction(action);
      if (error !== undefined) return record(action, "failed", error);
      if (tool === TOOL_SEARCH_TOOL) return search(action, args);
      if (tool === TOOL_DESCRIBE_TOOL) return describe(action, args);
      const { name, target, action: composed } = resolve(args);
      if (target === undefined) return unknown(action, name);
      // The wrapped adapter, with the composed action a direct call would have used: every gate
      // the seat would have hit on its own is hit here, in the same order, with the same key.
      return target.execute(composed, payload);
    },
    restrict(keep) {
      const kept = adapters.filter(keep);
      return createBridge(kept, disclosure.forAdapters(kept));
    },
    async cleanup() {},
  };
  return bridge;
}

/** The lazy view of one adapter with its deferred tool names taken out of the advertised set. */
function maskAdapter(adapter: TrentToolAdapter, disclosure: Disclosure): TrentToolAdapter {
  const hidden = (): string[] => toolNamesOf(adapter).filter((tool) => disclosure.isDeferred(adapter, tool));
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "scopes") {
        const gone = new Set(hidden());
        return target.scopes.filter((scope) => !gone.has(scope));
      }
      if (property === "instructions") {
        const gone = hidden();
        if (gone.length === 0) return target.instructions;
        const blocks = parseToolBlocks(target.instructions, gone);
        let text = target.instructions;
        for (const name of gone) {
          const block = blocks.get(name);
          if (block !== undefined) text = text.replace(block, "");
        }
        const note = `${gone.length} more ${target.name} tool(s) are registered but not listed here. Find them with ${TOOL_SEARCH_TOOL} and run them with ${TOOL_CALL_TOOL}.`;
        return `${text.replace(/\n{3,}/g, "\n\n").trim()}\n\n${note}`.trim();
      }
      return Reflect.get(target, property, target);
    },
  });
}

/**
 * True when this build has, or can have, tools worth deferring. MCP discovery has not finished
 * when the tool builder returns, so a configured server counts even before it answers `tools/list`.
 */
function worthDisclosing(adapters: readonly TrentToolAdapter[], toolsets: ToolsetLookup, options: DisclosureOptions): boolean {
  const threshold = options.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD;
  if (Object.keys(options.mcpServers ?? {}).length > 0) return true;
  let total = 0;
  for (const adapter of adapters) {
    const names = toolNamesOf(adapter);
    total += names.length;
    if (toolsets[adapter.name] === undefined && !isCore(adapter)) return true;
    if (names.some((name) => !isBuiltinToolName(name))) return true;
  }
  return total > threshold;
}

/**
 * The advertised adapter list: the same adapters, with the deferred names masked out, plus the
 * bridge. Returns the input unchanged when there is nothing to defer, so a small install pays
 * nothing for a mechanism it does not need.
 */
export function discloseAdapters(
  adapters: readonly TrentToolAdapter[],
  toolsets: ToolsetLookup,
  options: DisclosureOptions = {},
): TrentToolAdapter[] {
  if (!worthDisclosing(adapters, toolsets, options)) return [...adapters];
  const disclosure = new Disclosure(adapters, toolsets, options.threshold ?? DEFAULT_DISCLOSURE_THRESHOLD);
  return [...adapters.map((adapter) => maskAdapter(adapter, disclosure)), createBridge(adapters, disclosure)];
}
