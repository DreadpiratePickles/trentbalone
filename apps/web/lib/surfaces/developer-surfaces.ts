import { getMcpToolDefinitions } from "@/lib/mcp-server/registry";
import {
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "@/lib/webhooks";
import { INBOUND_WEBHOOK_ACTIONS, WEBHOOK_EVENTS, WEBHOOK_EVENTS_WITHOUT_SOURCE } from "@/lib/webhooks-types";

export function createPublicApiDescriptor() {
  return {
    version: "v1",
    auth: "scoped_bearer_token",
    scopes: ["companies:read", "approvals:read", "approvals:write", "tasks:write", "webhooks:write"],
    resources: ["/api/companies", "/api/approvals", "/api/tasks", "/api/surfaces"],
  };
}

/** Mirrors lib/webhooks.ts: only events with a bus source are listed as delivered. */
export function createWebhookSurface() {
  return {
    events: [...WEBHOOK_EVENTS],
    eventsWithoutSource: [...WEBHOOK_EVENTS_WITHOUT_SOURCE],
    payload: ["id", "event", "companyId", "occurredAt", "data"],
    signatureHeader: "x-trent-signature",
    timestampHeader: "x-trent-timestamp",
    signature: "sha256=hmac_sha256(secret, timestamp + '.' + body)",
    timestampToleranceSeconds: WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
    retryPolicy: {
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: "exponential",
      disableAfterConsecutiveFailures: WEBHOOK_DISABLE_AFTER_FAILURES,
    },
    management: "/api/companies/:id/webhooks",
    inbound: {
      endpoint: "/api/hooks/:id",
      auth: "bearer_secret",
      idempotencyHeader: "x-trent-idempotency-key",
      actions: [...INBOUND_WEBHOOK_ACTIONS],
    },
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
