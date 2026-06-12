import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);

vi.mock("@/components/shell", () => ({
  AppShell: ({ companyId, children }: { companyId: string; children: React.ReactNode }) => (
    <div data-company-id={companyId}>{children}</div>
  ),
}));

vi.mock("@/components/mcp-servers-panel", () => ({
  McpServersPanel: ({ companyId }: { companyId: string }) => <section data-testid="mcp-servers-panel">{companyId}</section>,
}));

describe("MCP page", () => {
  it("renders the MCP servers panel for the company", async () => {
    const { default: Page } = await import("./page");

    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "co_123" }) }));

    expect(html).toContain("data-testid=\"mcp-servers-panel\"");
    expect(html).toContain("co_123");
  });
});
