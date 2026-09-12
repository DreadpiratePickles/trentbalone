import { describe, it, expect } from "vitest";
import {
  MCP_CONNECTOR_GALLERY,
  MCP_MARKETPLACE_SOURCES,
  findMcpConnectorTemplateForServer,
  mcpConnectorGrantLabel,
  mcpConnectorSourceLabel,
} from "./index.js";

describe("mcp wrapper — connector resolution", () => {
  it("resolves a differently-named server to stripe by URL", () => {
    const match = findMcpConnectorTemplateForServer({
      name: "My Payments Server",
      url: "https://mcp.stripe.com/v1",
    });
    expect(match?.id).toBe("stripe");
  });

  it("resolves an unreachable internal server to stripe by TAG", () => {
    const match = findMcpConnectorTemplateForServer({
      name: "internal billing",
      url: "https://x.invalid",
    });
    expect(match?.id).toBe("stripe");
    expect(match?.defaultPolicy).toBe("always_approve");
    expect(match?.policyClasses).toContain("money_moving");
  });

  it("returns undefined when nothing matches by name, url or tag", () => {
    expect(
      findMcpConnectorTemplateForServer({ name: "zzz nothing here", url: "https://nope.invalid" }),
    ).toBeUndefined();
  });
});

describe("mcp wrapper — gallery shape and labels", () => {
  it("exposes 9 connectors with unique ids", () => {
    expect(MCP_CONNECTOR_GALLERY).toHaveLength(9);
    expect(new Set(MCP_CONNECTOR_GALLERY.map((c) => c.id)).size).toBe(9);
  });

  it("labels every source declared by a connector", () => {
    for (const connector of MCP_CONNECTOR_GALLERY) {
      expect(MCP_MARKETPLACE_SOURCES.some((s) => s.source === connector.source)).toBe(true);
      expect(mcpConnectorSourceLabel(connector.source)).not.toBe("");
    }
    expect(mcpConnectorSourceLabel("self_hosted")).toBe("Self-hosted");
  });

  it("humanises grant modes", () => {
    expect(mcpConnectorGrantLabel("oauth_user")).toBe("OAuth / per-user grant");
    expect(mcpConnectorGrantLabel("none")).toBe("No credential");
  });
});
