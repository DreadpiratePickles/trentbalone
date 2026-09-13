/** The `mcp_servers` config block: names, transports, env templates, and the legacy array shape. */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { McpServersConfigSchema, TrentConfigSchema } from "./schema.js";

describe("mcp_servers config", () => {
  it("defaults to an empty record", () => {
    expect(DEFAULT_CONFIG.mcp_servers).toEqual({});
    expect(TrentConfigSchema.parse({}).mcp_servers).toEqual({});
  });

  it("accepts a stdio server and an http server, filling defaults", () => {
    const parsed = McpServersConfigSchema.parse({
      fs: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { TOKEN: "${MY_TOKEN}" } },
      remote: { transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${MCP_TOKEN}" } },
    });
    expect(parsed.fs).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { TOKEN: "${MY_TOKEN}" },
      auto_approve: [],
      enabled: true,
    });
    expect(parsed.remote).toMatchObject({ transport: "http", url: "https://mcp.example.com/mcp", auto_approve: [], enabled: true });
  });

  it("infers the transport from command vs url, the way Hermes's config does", () => {
    const parsed = McpServersConfigSchema.parse({ local: { command: "x" }, remote: { url: "https://h/mcp" } });
    expect(parsed.local!.transport).toBe("stdio");
    expect(parsed.remote!.transport).toBe("http");
  });

  it("refuses bad names, empty commands, non-http urls and an unknown transport", () => {
    expect(McpServersConfigSchema.safeParse({ Bad: { transport: "stdio", command: "x" } }).success).toBe(false);
    expect(McpServersConfigSchema.safeParse({ a: { transport: "stdio", command: "x" } }).success).toBe(false);
    expect(McpServersConfigSchema.safeParse({ ok: { transport: "stdio", command: "" } }).success).toBe(false);
    expect(McpServersConfigSchema.safeParse({ ok: { transport: "http", url: "ftp://h" } }).success).toBe(false);
    expect(McpServersConfigSchema.safeParse({ ok: { transport: "sse", url: "https://h" } }).success).toBe(false);
  });

  it("migrates the legacy `[{name, url}]` array written by the old CLI into http entries", () => {
    const parsed = McpServersConfigSchema.parse([{ name: "old", url: "https://mcp.example.com/mcp" }, { name: "nourl" }]);
    expect(Object.keys(parsed)).toEqual(["old"]);
    expect(parsed.old).toMatchObject({ transport: "http", url: "https://mcp.example.com/mcp" });
  });
});
