import { getMcpToolDefinitions } from "@/lib/mcp-server/registry";

export function createPublicApiDescriptor() {
  return {
    version: "v1",
    auth: "scoped_bearer_token",
    scopes: ["companies:read", "approvals:read", "approvals:write", "tasks:write", "webhooks:write"],
    resources: ["/api/companies", "/api/approvals", "/api/tasks", "/api/surfaces"],
  };
}

export function createWebhookSurface() {
  return {
    events: ["approval.created", "approval.resolved", "task.completed", "spend.paused"],
    signatureHeader: "x-trent-signature",
    retryPolicy: { attempts: 5, backoff: "exponential" },
  };
}

export function createMcpServerDescriptor() {
  const tools = getMcpToolDefinitions().map(({ name, description, inputSchema, requiredScope }) => ({
    name,
    description,
    inputSchema,
    requiredScope,
  }));

  return {
    name: "trent-os",
    protocolVersion: "2025-06-18",
    transport: "streamable_http",
    endpoint: "/api/mcp",
    auth: "bearer_api_key",
    scopes: ["mcp", "mcp:approve"],
    tools,
  };
}
