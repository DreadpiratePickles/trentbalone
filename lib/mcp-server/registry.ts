import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { RUN_AGENT_TOOL } from "./run-agent";
import { sanitizeMcpError } from "./sanitize";
import { APPROVAL_TOOLS } from "./tools-approvals";
import { READ_TOOLS } from "./tools-read";
import type { McpAuthContext, McpToolDefinition, McpToolDescriptor, McpToolResult } from "./types";

const TOOLS: McpToolDefinition[] = [
  ...READ_TOOLS,
  RUN_AGENT_TOOL,
  ...APPROVAL_TOOLS,
];

export function getMcpToolDefinitions(): McpToolDefinition[] {
  return TOOLS;
}

export function listMcpTools(ctx?: McpAuthContext): McpToolDescriptor[] {
  return TOOLS
    .filter((tool) => !ctx || ctx.scopes.includes(tool.requiredScope))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callMcpTool(
  ctx: McpAuthContext,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`unknown tool "${name}"`);
  if (!ctx.scopes.includes(tool.requiredScope)) {
    return errorResult(
      tool.requiredScope === "mcp:approve"
        ? "approval_scope_required"
        : "insufficient scope for this tool"
    );
  }

  await store.addAudit(
    ctx.companyId,
    "agent",
    "mcp_tool_call",
    "mcp_tool",
    tool.name,
    `MCP key ${ctx.maskedKey} (${ctx.keyId}) called ${tool.name} [${argDigest(args)}]`
  ).catch(() => undefined);

  try {
    const payload = await withRlsContext(ctx.companyId, () => tool.handler(ctx, args));
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  } catch (error) {
    return errorResult(sanitizeMcpError(error));
  }
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function argDigest(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (!keys.length) return "no args";
  return keys
    .sort()
    .map((key) => {
      const value = args[key];
      const size = typeof value === "string" ? `${value.length}ch` : Array.isArray(value) ? `${value.length} items` : typeof value;
      return `${key}(${size})`;
    })
    .join(", ");
}
