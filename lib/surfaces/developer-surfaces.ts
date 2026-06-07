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
  return {
    name: "trent-os",
    transport: "stdio",
    tools: [
      { name: "list_company_context", inputSchema: { companyId: "string" } },
      { name: "create_approval", inputSchema: { companyId: "string", action: "string", reason: "string" } },
      { name: "list_pending_actions", inputSchema: { companyId: "string" } },
      { name: "create_task", inputSchema: { companyId: "string", prompt: "string" } },
    ],
  };
}
