import { describe, expect, it } from "vitest";
import { createMcpServerDescriptor, createPublicApiDescriptor, createWebhookSurface } from "./developer-surfaces";

describe("developer surfaces", () => {
  it("declares public API scopes and webhook signature requirements", () => {
    const api = createPublicApiDescriptor();
    const webhook = createWebhookSurface();
    expect(api.scopes).toContain("approvals:write");
    expect(api.resources).toContain("/api/approvals");
    expect(webhook.events).toContain("approval.created");
    expect(webhook.events).toContain("run.completed");
    expect(webhook.events).not.toContain("spend.paused");
    expect(webhook.eventsWithoutSource).toContain("spend.paused");
    expect(webhook.signatureHeader).toBe("x-trent-signature");
    expect(webhook.timestampHeader).toBe("x-trent-timestamp");
    expect(webhook.retryPolicy).toEqual({ attempts: 5, backoff: "exponential", disableAfterConsecutiveFailures: 10 });
    expect(webhook.inbound).toEqual({ endpoint: "/api/hooks/:id", auth: "bearer_secret", idempotencyHeader: "x-trent-idempotency-key", actions: ["create_task", "start_run"] });
  });

  it("declares Trent MCP tools for IDE agents", () => {
    const descriptor = createMcpServerDescriptor();
    expect(descriptor.name).toBe("trent-os");
    expect(descriptor.transport).toBe("streamable_http");
    expect(descriptor.endpoint).toBe("/api/mcp");
    expect(descriptor.auth).toBe("bearer_api_key");
    expect(descriptor.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "trent_company_context",
      "trent_run_agent",
      "trent_get_run",
      "trent_resolve_approval",
    ]));
    expect(JSON.stringify(descriptor.tools)).not.toContain("companyId");
  });
});
