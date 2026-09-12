import { NextRequest, NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/audit-log";
import { classifyMcpToolPolicyClasses, defaultMcpApprovalPolicyForTool, mcpToolRiskLabel } from "@/lib/mcp-policy";
import { getMcpServer, updateMcpServer } from "@/lib/mcp-store";
import { discoverMcpTools } from "@/lib/mcp-tool-adapter";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

export const maxDuration = 60;

type ProofAction = "test_read" | "test_write_dry_run" | "reapprove_changed_tools";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, serverId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as { action?: string; toolName?: string };
  const action = normalizeProofAction(body.action);
  if (!action) return NextResponse.json({ error: "unsupported proof action" }, { status: 400 });

  const server = await getMcpServer(companyId, serverId);
  if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });

  const startedAt = Date.now();
  if (action === "test_write_dry_run") {
    const tool = selectToolForDryRun(server, body.toolName);
    const classes = classifyMcpToolPolicyClasses(tool);
    const policy = server.approvalPolicies?.[tool.name] ?? defaultMcpApprovalPolicyForTool(tool);
    const latencyMs = Date.now() - startedAt;
    const summary = `Dry-run classified ${server.name}.${tool.name} as ${mcpToolRiskLabel(classes)} risk; policy=${policy}; no remote tool call executed.`;
    await appendAuditLog(companyId, "user", "mcp.proof.write_dry_run", "mcp_server", server.id, summary).catch(() => undefined);
    return NextResponse.json({
      proof: {
        action,
        status: "passed",
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
        policy,
        policyClasses: classes,
        risk: mcpToolRiskLabel(classes),
        latencyMs,
        evidence: summary,
        dryRun: true,
      },
    });
  }

  try {
    const tools = await discoverMcpTools(server);
    const updated = await updateMcpServer(companyId, serverId, {
      discoveredTools: tools,
      status: "connected",
      lastError: null,
    });
    const latencyMs = Date.now() - startedAt;
    const auditAction = action === "reapprove_changed_tools" ? "mcp.proof.reapprove" : "mcp.proof.test_read";
    const summary = `${server.name} ${action === "reapprove_changed_tools" ? "re-approved" : "read-tested"}: discovery returned ${tools.length} tool(s) in ${latencyMs}ms.`;
    await appendAuditLog(companyId, "user", auditAction, "mcp_server", server.id, summary).catch(() => undefined);
    return NextResponse.json({
      server: updated,
      proof: {
        action,
        status: "passed",
        serverId: server.id,
        serverName: server.name,
        toolCount: tools.length,
        latencyMs,
        evidence: summary,
        dryRun: false,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP proof failed";
    const latencyMs = Date.now() - startedAt;
    const updated = await updateMcpServer(companyId, serverId, {
      status: "error",
      lastError: message.slice(0, 500),
    });
    const summary = `${server.name} ${action} failed in ${latencyMs}ms: ${message.slice(0, 300)}`;
    await appendAuditLog(companyId, "user", "mcp.proof.failed", "mcp_server", server.id, summary).catch(() => undefined);
    return NextResponse.json({
      server: updated,
      proof: {
        action,
        status: "failed",
        serverId: server.id,
        serverName: server.name,
        latencyMs,
        evidence: summary,
        error: message,
      },
    }, { status: 502 });
  }
}

function normalizeProofAction(action: unknown): ProofAction | undefined {
  if (action === "test_read" || action === "test_write_dry_run" || action === "reapprove_changed_tools") return action;
  return undefined;
}

function selectToolForDryRun(server: Awaited<ReturnType<typeof getMcpServer>>, preferred?: string) {
  const fallback = { name: preferred || "write_action", description: "Write action dry-run" };
  if (!server) return fallback;
  const tools = server.discoveredTools;
  return tools.find((tool) => tool.name === preferred)
    ?? tools.find((tool) => defaultMcpApprovalPolicyForTool(tool) !== "read_only_auto")
    ?? tools[0]
    ?? fallback;
}
