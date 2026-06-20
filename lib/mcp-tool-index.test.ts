import { describe, expect, it } from "vitest";
import { buildMcpToolInventory, rankMcpServersForTask, searchMcpToolInventory } from "@/lib/mcp-tool-index";
import type { McpServerRecord } from "@/lib/mcp-store";

describe("MCP tool search and deferred loading", () => {
  it("ranks only relevant enabled servers for a task query", () => {
    const ranked = rankMcpServersForTask([
      server({
        id: "mcp_sentry",
        name: "Sentry",
        discoveredTools: [
          { name: "find_errors", title: "Find errors", description: "Search production errors and stack traces" },
        ],
      }),
      server({
        id: "mcp_github",
        name: "GitHub",
        discoveredTools: [
          { name: "create_issue", title: "Create issue", description: "Create GitHub issues from incidents" },
        ],
      }),
      server({
        id: "mcp_notion",
        name: "Notion",
        discoveredTools: [
          { name: "update_page", title: "Update page", description: "Update a wiki page" },
        ],
      }),
      server({ id: "mcp_disabled", name: "Stripe", enabled: false }),
    ], "Investigate Sentry production errors and open a GitHub issue", { limit: 2 });

    expect(ranked.map((item) => item.server.id)).toEqual(["mcp_sentry", "mcp_github"]);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("falls back to the strongest connected servers when the task has no lexical match", () => {
    const ranked = rankMcpServersForTask([
      server({ id: "mcp_1", name: "Stripe", discoveredTools: [{ name: "search", description: "Search payments" }] }),
      server({ id: "mcp_2", name: "Sentry", discoveredTools: [] }),
    ], "Do the daily operator sweep", { limit: 1 });

    expect(ranked.map((item) => item.server.id)).toEqual(["mcp_1"]);
  });

  it("builds searchable inventory with owner, risk, schemas, proof, and availability reasons", () => {
    const inventory = buildMcpToolInventory([
      server({
        id: "mcp_stripe",
        name: "Stripe",
        url: "https://mcp.stripe.com",
        discoveredTools: [
          {
            name: "stripe_refund",
            title: "Refund payment",
            description: "Create a customer refund",
            inputSchema: { type: "object" },
            annotations: { destructiveHint: true },
          },
        ],
      }),
    ]);

    expect(inventory[0]).toMatchObject({
      owner: "Stripe",
      risk: "critical",
      schema: { input: "present", output: "missing" },
      lastProof: { status: "passed" },
    });
    expect(inventory[0]?.whyAvailable).toContain("enabled");
    expect(searchMcpToolInventory(inventory, "refund customer")[0]?.toolName).toBe("stripe_refund");
  });
});

function server(overrides: Partial<McpServerRecord>): McpServerRecord {
  return {
    id: "mcp_1",
    companyId: "co_1",
    name: "Server",
    url: "https://mcp.example.com",
    transport: "http",
    hasCredential: true,
    toolAllowlist: [],
    reversibleTools: [],
    approvalPolicies: {},
    status: "connected",
    discoveredTools: [],
    enabled: true,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}
