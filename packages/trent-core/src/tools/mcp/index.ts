/**
 * `mcp`: every tool of every server in `config.mcp_servers`, as ONE adapter whose scopes are
 * `mcp_<server>_<tool>` plus `mcp_status`. Discovery speaks the real protocol (`tools/list`) at
 * build time; a server that cannot be reached is carried as `unavailable` with its reason, shown
 * by `mcp_status` and in the adapter's instructions, never dropped silently.
 *
 * Approval: every MCP tool call requires approval (an MCP server is live write access to a
 * third-party system) unless the server's `auto_approve` lists that tool by its own name.
 * Results follow the spillover rule (`fitSummary`). Connections stay open for the seat's life;
 * `cleanup()` closes them.
 *
 * Sync/async: `createMcpAdapter` returns immediately with a `ready` promise (the tool builder is
 * synchronous); `createMcpAdapters` awaits it and returns the `{adapters, unavailable}` shape.
 */
import type { McpServerConfig, McpServersConfig } from "../../config/schema.js";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { connectFailureReason, connectMcpServer, type McpConnectDeps, type McpConnection, type McpToolInfo } from "./client.js";
import { mcpToolName } from "./config.js";

export { connectMcpServer, connectFailureReason, MCP_CONNECT_TIMEOUT_MS, type McpConnection, type McpConnectDeps, type McpToolInfo } from "./client.js";
export { mcpToolName, resolveTemplate, resolveTemplateRecord, containsTemplate, sanitiseComponent, MCP_SERVER_NAME_PATTERN } from "./config.js";
export { scanMcpTools, scrubMcpResult, toolInstructionStrings, type McpScanFinding } from "./scan.js";

export const MCP_ADAPTER_NAME = "mcp";
export const MCP_STATUS_TOOL = "mcp_status";
const ROUTING_TEXT = "MCP server tools, Model Context Protocol connector, external integration via MCP";

const STATUS_SCHEMA: ToolSchema = {
  name: MCP_STATUS_TOOL,
  description: "List every configured MCP server: connected ones with their tools, unavailable ones with the reason.",
  parameters: { type: "object", properties: {} },
};

export interface McpBuildConfig {
  readonly mcp_servers?: McpServersConfig;
}

export interface McpAdapterDeps extends Omit<McpConnectDeps, "env"> {
  readonly profileDir: string;
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface UnavailableMcpServer {
  readonly name: string;
  readonly reason: string;
}

export interface McpAdapterBuild {
  readonly adapters: TrentToolAdapter[];
  readonly unavailable: UnavailableMcpServer[];
}

export interface McpToolAdapter extends TrentToolAdapter {
  /** Resolves when every server has connected or been marked unavailable. */
  readonly ready: Promise<UnavailableMcpServer[]>;
  readonly unavailable: readonly UnavailableMcpServer[];
}

interface ExposedTool {
  readonly server: string;
  readonly tool: McpToolInfo;
  readonly autoApprove: boolean;
  readonly schema: ToolSchema;
}

interface State {
  readonly connections: Map<string, McpConnection>;
  readonly tools: Map<string, ExposedTool>;
  readonly unavailable: UnavailableMcpServer[];
}

async function connectOne(name: string, config: McpServerConfig, deps: McpConnectDeps, state: State): Promise<void> {
  if (!config.enabled) {
    state.unavailable.push({ name, reason: "disabled in config" });
    return;
  }
  let connection: McpConnection;
  try {
    connection = await connectMcpServer(name, config, deps);
  } catch (error) {
    state.unavailable.push({ name, reason: connectFailureReason(error) });
    return;
  }
  let listed: McpToolInfo[];
  try {
    listed = await connection.listTools();
  } catch (error) {
    await connection.close();
    state.unavailable.push({ name, reason: `tools/list failed: ${connectFailureReason(error)}` });
    return;
  }
  state.connections.set(name, connection);
  const autoApprove = new Set(config.auto_approve);
  for (const tool of listed) {
    const exposed = mcpToolName(name, tool.name);
    if (state.tools.has(exposed)) {
      state.unavailable.push({ name, reason: `tool "${tool.name}" would collide with ${exposed} from server "${state.tools.get(exposed)!.server}"; skipped` });
      continue;
    }
    const description = tool.description || `${tool.name} on MCP server ${name}`;
    state.tools.set(exposed, {
      server: name,
      tool,
      autoApprove: autoApprove.has(tool.name),
      schema: { name: exposed, description: `[${name}] ${description}${autoApprove.has(tool.name) ? "" : " Requires approval."}`, parameters: tool.inputSchema },
    });
  }
}

function renderStatus(config: McpServersConfig, state: State): string {
  const names = Object.keys(config).sort();
  if (!names.length) return "no MCP servers configured (trent mcp add <name> --command ... | --url ...)";
  const lines = ["MCP servers:"];
  for (const name of names) {
    const tools = [...state.tools.values()].filter((t) => t.server === name).map((t) => t.schema.name);
    if (state.connections.has(name)) lines.push(`- ${name}: connected, ${tools.length} tool(s)${tools.length ? `: ${tools.join(", ")}` : ""}`);
    for (const entry of state.unavailable.filter((u) => u.name === name)) lines.push(`- ${name}: unavailable, ${entry.reason}`);
  }
  return lines.join("\n");
}

/** Builds the adapter synchronously; discovery runs in the background and `ready` resolves when done. */
export function createMcpAdapter(config: McpBuildConfig, deps: McpAdapterDeps): McpToolAdapter {
  const servers: McpServersConfig = config.mcp_servers ?? {};
  const connectDeps: McpConnectDeps = { ...deps, env: deps.env ?? process.env };
  const state: State = { connections: new Map(), tools: new Map(), unavailable: [] };
  const ready = Promise.all(
    Object.keys(servers)
      .sort()
      .map((name) => connectOne(name, servers[name]!, connectDeps, state)),
  ).then(() => [...state.unavailable]);

  const specs = (): ToolSpec[] => [
    { name: MCP_STATUS_TOOL, primary: "", signature: ["__mcp_status__"] },
    ...[...state.tools.values()].map((t) => ({
      name: t.schema.name,
      primary: t.schema.parameters.required?.[0] ?? Object.keys(t.schema.parameters.properties)[0] ?? "input",
      signature: [`__${t.schema.name}__`],
    })),
  ];
  const instructions = (): string => {
    const schemas = [STATUS_SCHEMA, ...[...state.tools.values()].map((t) => t.schema)];
    const notes = state.unavailable.map((u) => `${u.name}: unavailable (${u.reason})`);
    return renderToolInstructions(schemas) + (notes.length ? `\n\nUnavailable MCP servers:\n${notes.map((n) => `  ${n}`).join("\n")}` : "");
  };
  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(MCP_ADAPTER_NAME, action, status, fitSummary(summary, deps.profileDir, "mcp"));

  async function run(action: string, entry: ExposedTool, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const connection = state.connections.get(entry.server);
    if (!connection) return record(action, "failed", `MCP server "${entry.server}" is not connected.`);
    try {
      const result = await connection.callTool(entry.tool.name, args);
      return record(action, result.isError ? "failed" : "completed", result.text);
    } catch (error) {
      return record(action, "failed", `${entry.schema.name} failed: ${connectFailureReason(error)}`);
    }
  }

  return {
    name: MCP_ADAPTER_NAME,
    get scopes() {
      return [MCP_ADAPTER_NAME, MCP_STATUS_TOOL, ...state.tools.keys()];
    },
    get availability() {
      return state.tools.size ? ("real" as const) : ("unavailable" as const);
    },
    get instructions() {
      return instructions();
    },
    get routingText() {
      return `${ROUTING_TEXT}${state.tools.size ? `: ${[...state.tools.keys()].join(", ")}` : ""}`;
    },
    get unavailable() {
      return [...state.unavailable];
    },
    ready,
    healthCheck: async () => {
      await ready;
      return state.connections.size ? "connected" : "needs_credentials";
    },
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, error } = parseAction(action, specs());
      if (error || tool === MCP_STATUS_TOOL) return false;
      const entry = state.tools.get(tool);
      return entry ? !entry.autoApprove : false;
    },
    async dryRun(action) {
      const { tool } = parseAction(action, specs());
      const entry = state.tools.get(tool);
      if (!entry) return record(action, "mocked", `mcp dry-run: "${action.slice(0, 120)}" is not an MCP tool.`);
      if (entry.autoApprove) return record(action, "mocked", `${tool} is auto-approved for server ${entry.server}; it would run now.`);
      return record(action, "needs_approval", `MCP tool ${entry.tool.name} on server ${entry.server} needs approval before it acts in that system.`);
    },
    async execute(action) {
      await ready;
      const { tool, args, error } = parseAction(action, specs());
      if (error) return record(action, "failed", error);
      if (tool === MCP_STATUS_TOOL) return record(action, "completed", renderStatus(servers, state));
      const entry = state.tools.get(tool);
      if (!entry) return record(action, "failed", `Unknown MCP tool "${tool}". Known: ${[...state.tools.keys()].join(", ") || "none"}.`);
      return run(action, entry, args);
    },
    async cleanup() {
      await ready;
      await Promise.all([...state.connections.values()].map((c) => c.close()));
      state.connections.clear();
    },
  };
}

/** The async shape: one adapter, every server connected or explained. */
export async function createMcpAdapters(config: McpBuildConfig, deps: McpAdapterDeps): Promise<McpAdapterBuild> {
  const adapter = createMcpAdapter(config, deps);
  const unavailable = await adapter.ready;
  return { adapters: [adapter], unavailable };
}
