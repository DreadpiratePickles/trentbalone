import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/mcp-servers-panel", () => ({
  McpServersPanel: ({ companyId }: { companyId: string }) => <section data-testid="mcp-servers-panel">{companyId}</section>,
}));

import { IntegrationsPageClient } from "@/components/sub-pages";

describe("IntegrationsPageClient MCP front door", () => {
  it("renders the MCP servers panel inside integrations", () => {
    const html = renderToStaticMarkup(<IntegrationsPageClient companyId="co_123" />);

    expect(html).toContain("data-testid=\"mcp-servers-panel\"");
    expect(html).toContain("co_123");
  });
});
