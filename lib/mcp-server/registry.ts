import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { RUN_AGENT_TOOL } from "./run-agent";
import { sanitizeMcpError } from "./sanitize";
import { APPROVAL_TOOLS } from "./tools-approvals";
import {
  READ_TOOLS,
  companyContextHandler,
  listAppSoloOptionsHandler,
  listPendingApprovalsHandler,
} from "./tools-read";
import type {
  McpAuthContext,
  McpPromptDescriptor,
  McpPromptResult,
  McpResourceDescriptor,
  McpResourceReadResult,
  McpToolDefinition,
  McpToolDescriptor,
  McpToolResult,
} from "./types";

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

export function listMcpResources(_ctx: McpAuthContext): McpResourceDescriptor[] {
  return [
    {
      uri: "trent://company/context",
      name: "Company context",
      description: "Company operating profile, metrics, autonomy settings, and pending approval count.",
      mimeType: "application/json",
    },
    {
      uri: "trent://company/pending-approvals",
      name: "Pending approvals",
      description: "Founder approvals waiting for action, including related run links.",
      mimeType: "application/json",
    },
    {
      uri: "trent://company/app-solo-options",
      name: "App-Solo options",
      description: "Seat-specific App-Solo workflows, scopes, deliverables, and approval gates.",
      mimeType: "application/json",
    },
  ];
}

export async function readMcpResource(ctx: McpAuthContext, uri: string): Promise<McpResourceReadResult> {
  const handlers: Record<string, () => Promise<unknown>> = {
    "trent://company/context": () => companyContextHandler(ctx),
    "trent://company/pending-approvals": () => listPendingApprovalsHandler(ctx),
    "trent://company/app-solo-options": () => listAppSoloOptionsHandler(),
  };
  const handler = handlers[uri];
  if (!handler) {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ error: "unknown resource" }) }] };
  }
  const payload = await withRlsContext(ctx.companyId, handler);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
}

export function listMcpPrompts(_ctx: McpAuthContext): McpPromptDescriptor[] {
  return [
    {
      name: "daily-operator",
      description: "Run Trent's daily operator loop for a company focus area.",
      arguments: [{ name: "focus", description: "Optional focus area such as sales, support, reliability, or finance." }],
    },
    {
      name: "app-solo-delivery",
      description: "Launch a seat-specific App-Solo work session with evidence and approval gates.",
      arguments: [
        { name: "role", description: "Seat role, for example engineer or growth.", required: true },
        { name: "objective", description: "The concrete outcome Trent should deliver.", required: true },
      ],
    },
    {
      name: "approval-review",
      description: "Review pending approvals and prepare a founder decision packet.",
    },
  ];
}

export function getMcpPrompt(_ctx: McpAuthContext, name: string, args: Record<string, unknown>): McpPromptResult {
  const focus = typeof args.focus === "string" && args.focus.trim() ? ` Focus: ${args.focus.trim()}.` : "";
  const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : "engineer";
  const objective = typeof args.objective === "string" && args.objective.trim() ? args.objective.trim() : "Deliver the requested outcome.";
  const prompts: Record<string, string> = {
    "daily-operator": `Run Trent's daily operator loop for this company.${focus} Read trent://company/context first, inspect pending approvals, then create or run the highest-leverage task with evidence.`,
    "app-solo-delivery": `Use trent_run_agent with engine=solo, role=${role}, and objective: ${objective}. Poll trent_get_run until evidence, product review, approvals, or completion is available.`,
    "approval-review": "Read trent://company/pending-approvals, group approvals by risk, and prepare a founder decision packet with recommended approve/reject actions.",
  };
  return {
    messages: [{
      role: "user",
      content: { type: "text", text: prompts[name] ?? `Use Trent MCP tools to complete: ${name}` },
    }],
  };
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
