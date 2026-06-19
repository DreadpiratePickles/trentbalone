import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  McpConnectorGallery,
  McpServerCommandCenterCard,
} from "@/components/mcp-servers-panel";

describe("MCP Connector Command Center UI", () => {
  it("renders the curated connector gallery with trust and auth metadata", () => {
    const html = renderToStaticMarkup(
      <McpConnectorGallery onSelect={() => undefined} />,
    );

    for (const name of ["Stripe", "GitHub", "Sentry", "Microsoft Learn", "Notion", "Atlassian", "Zapier", "Pipedream"]) {
      expect(html).toContain(name);
    }
    expect(html).toContain("OAuth");
    expect(html).toContain("trust");
    expect(html).toContain("resources");
    expect(html).toContain("prompts");
  });

  it("renders structured approval policies and full discovered schema metadata", () => {
    const html = renderToStaticMarkup(
      <McpServerCommandCenterCard
        server={{
          id: "mcp_1",
          name: "Stripe",
          url: "https://mcp.stripe.com",
          transport: "http",
          hasCredential: true,
          toolAllowlist: ["stripe_search", "stripe_refund"],
          reversibleTools: [],
          approvalPolicies: {
            stripe_search: "read_only_auto",
            stripe_refund: "always_approve",
          },
          status: "connected",
          discoveredTools: [
            {
              name: "stripe_search",
              title: "Search Stripe",
              description: "Search Stripe objects",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
              outputSchema: { type: "object", properties: { results: { type: "array" } } },
              annotations: { readOnlyHint: true },
            },
            {
              name: "stripe_refund",
              title: "Refund payment",
              description: "Create a payment refund",
              annotations: { destructiveHint: true },
            },
          ],
          enabled: true,
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z",
        }}
        discovering={false}
        onDiscover={() => undefined}
        onToggleEnabled={() => undefined}
        onRemove={() => undefined}
        onPolicyChange={() => undefined}
      />,
    );

    expect(html).toContain("Connector Command Center");
    expect(html).toContain("read-only auto");
    expect(html).toContain("always approve");
    expect(html).toContain("input schema");
    expect(html).toContain("output schema");
    expect(html).toContain("Search Stripe");
  });
});
