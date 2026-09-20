/**
 * U5 / G9 — Trent as an MCP server: the profile's toolsets, behind Trent's gates, for any MCP
 * client (Claude Code, Codex, Grok Build, the xAI Remote MCP API).
 *
 * One server object is ONE connection: it has a run id of its own (`mcp_<hex>`), so the
 * idempotency wrapper keys every side-effecting call under it (`governance/tool-call-context.ts`)
 * and its approval rows name it, and it is charged to `surface: "mcp"` on the spend ledger by
 * whoever opens its run scope (the CLI does; a test does not). The transport is the caller's:
 * stdio or Streamable HTTP (`transport.ts`).
 *
 * A call is dispatched to the adapter `buildTrentTools` returned, with the action a seat would
 * have composed (`<tool> <json>`), or through the disclosure bridge's `tool_call` for a deferred
 * tool, so autonomy, the hardline blocklist, deny globs, floors, policy rules, idempotency,
 * provenance and hooks all fire in their order. What the seat path leaves to its surface is done
 * here: a call the wrapper says needs approval is parked as a row the founder settles with
 * `trent approvals`, answered as a structured `needs_approval` result with the row id and the
 * adapter's preview, and executed only on the replay that finds the row approved (G2). A no is
 * a `blocked` result. Nothing is ever silently allowed.
 *
 * Results are scrubbed with the same detectors an MCP result reaching a seat passes
 * (`tools/mcp/scan.ts`), and hit counts, never values, go to the log.
 */
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import { StructuredLogger } from "../telemetry/logger.js";
import { scrubMcpResult } from "../tools/mcp/scan.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { approvalKey, createMcpApprovalGate, type McpApproval, type McpApprovalGate } from "./approvals.js";
import { buildToolCatalog, type TrentMcpTool } from "./catalog.js";

export const MCP_SERVER_NAME = "trent";
export const MCP_SURFACE = "mcp" as const;
const APPROVAL_ID = /\bappr_[A-Za-z0-9_]+\b/;

export interface TrentMcpServerOptions {
  /** The built adapter list (`buildTrentTools(...).adapters`, plus the fleet-memory adapters). */
  readonly adapters: readonly TrentToolAdapter[];
  readonly profileDir: string;
  /** Handed to every adapter call, as the seat loop hands it; `fleet_search` needs it. */
  readonly companyId?: string;
  readonly version?: string;
  /** Defaults to a fresh `mcp_<hex>` per server, which is per connection. */
  readonly runId?: string;
  /** Test seam over the profile's `gateway.json`. */
  readonly approvals?: McpApprovalGate;
  /** Where scrub hit counts go; never a value. Defaults to a `StructuredLogger` on stderr. */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface TrentMcpServer {
  readonly server: Server;
  readonly catalog: readonly TrentMcpTool[];
  readonly runId: string;
  readonly surface: typeof MCP_SURFACE;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** The `structuredContent` every result carries; a host that reads only text gets the same facts. */
interface StructuredResult {
  readonly status: ToolCallRecord["status"];
  readonly tool: string;
  readonly adapter: string;
  readonly surface: typeof MCP_SURFACE;
  readonly approval_id?: string;
  readonly preview?: string;
  readonly settle?: string;
}

function settleHint(id: string): string {
  return `trent approvals approve ${id} (or reject); then call again with the same arguments`;
}

function result(structured: StructuredResult, text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ...structured }, isError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createTrentMcpServer(options: TrentMcpServerOptions): TrentMcpServer {
  const runId = options.runId ?? `mcp_${randomBytes(6).toString("hex")}`;
  const catalog = buildToolCatalog(options.adapters);
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  const logger = options.log === undefined ? new StructuredLogger({ runId }) : undefined;
  const log = options.log ?? ((event: string, fields: Record<string, unknown>) => logger?.info(event, fields));
  const payload = options.companyId === undefined ? {} : { companyId: options.companyId };
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version ?? "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "Trent's toolsets, behind Trent's approval gates. A result with status needs_approval names an approval id the founder settles with " +
        "`trent approvals approve <id>`; call the tool again with the same arguments once it is approved.",
    },
  );
  let gate: McpApprovalGate | undefined;
  let calls = 0;

  /** Built on first use, once the client has said who it is. */
  const approvals = (): McpApprovalGate => {
    if (gate === undefined) {
      const client = server.getClientVersion()?.name ?? "unknown";
      gate = options.approvals ?? createMcpApprovalGate({ profileDir: options.profileDir, agentId: `mcp:${client}`, runId });
    }
    return gate;
  };

  const composed = (tool: TrentMcpTool, args: Record<string, unknown>): string =>
    tool.via === "bridge" ? `tool_call ${JSON.stringify({ name: tool.name, arguments: args })}` : `${tool.name} ${JSON.stringify(args)}`;

  async function preview(tool: TrentMcpTool, action: string): Promise<string> {
    if (tool.target.dryRun === undefined) return `${tool.adapter}: ${tool.name} requires approval before it runs.`;
    try {
      return (await tool.target.dryRun(action, payload)).summary;
    } catch (error) {
      return `${tool.adapter}: ${tool.name} requires approval before it runs (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  const parked = (tool: TrentMcpTool, row: McpApproval): CallToolResult =>
    result(
      { status: "needs_approval", tool: tool.name, adapter: tool.adapter, surface: MCP_SURFACE, approval_id: row.id, preview: row.preview, settle: settleHint(row.id) },
      `needs_approval ${row.id}: ${row.preview}\nSettle it with: ${settleHint(row.id)}`,
      false,
    );

  function rendered(tool: TrentMcpTool, record: ToolCallRecord, approval?: McpApproval): CallToolResult {
    const scrubbed = scrubMcpResult(record.summary);
    if (scrubbed.hits.length > 0) log("mcp.serve.result.redacted", { tool: tool.name, hits: scrubbed.hits });
    const base: StructuredResult = { status: record.status, tool: tool.name, adapter: tool.adapter, surface: MCP_SURFACE };
    if (record.status === "needs_approval") {
      // An adapter that parks on its own (a memory write held for its provenance) names the row
      // in its summary; the id is carried up so the host can name it back to the founder.
      const id = approval?.id ?? APPROVAL_ID.exec(scrubbed.text)?.[0];
      const settle = id === undefined ? undefined : settleHint(id);
      return result({ ...base, ...(id === undefined ? {} : { approval_id: id, settle }), preview: scrubbed.text }, scrubbed.text, false);
    }
    const isError = record.status === "failed" || record.status === "blocked";
    return result({ ...base, ...(approval === undefined ? {} : { approval_id: approval.id }) }, scrubbed.text, isError);
  }

  async function dispatch(tool: TrentMcpTool, args: Record<string, unknown>): Promise<CallToolResult> {
    const action = composed(tool, args);
    const key = approvalKey(runId, tool.name, args);
    let approval: McpApproval | undefined;
    let stepId = `call_${String(++calls)}`;
    if (tool.target.requiresApproval(action)) {
      const open = approvals().lookup(key);
      if (open === undefined) return parked(tool, approvals().request({ key, action: `${tool.name} ${JSON.stringify(args)}`, preview: await preview(tool, action) }));
      if (open.status === "pending") return parked(tool, open);
      if (open.status === "denied") {
        return result(
          { status: "blocked", tool: tool.name, adapter: tool.adapter, surface: MCP_SURFACE, approval_id: open.id },
          `blocked: the founder denied approval ${open.id} for this call.`,
          true,
        );
      }
      approval = open;
      // The approved call runs under the row's own step, so the idempotency key ties the
      // execution to the call that was previewed and a retry of it replays rather than repeats.
      stepId = open.id;
    }
    const record = await runWithToolCallContext({ runId, stepId }, () => tool.target.execute(action, payload));
    if (approval !== undefined && record.status !== "needs_approval") approvals().spend(approval.id);
    return rendered(tool, record, approval);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: catalog.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (tool === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    const args = isRecord(request.params.arguments) ? request.params.arguments : {};
    return dispatch(tool, args);
  });

  return {
    server,
    catalog,
    runId,
    surface: MCP_SURFACE,
    connect: (transport) => server.connect(transport),
    close: () => server.close(),
  };
}
