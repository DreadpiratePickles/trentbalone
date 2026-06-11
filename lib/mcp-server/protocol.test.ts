import { describe, expect, it, vi } from "vitest";
import { handleMcpMessage } from "./protocol";
import type { McpAuthContext } from "./types";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp"],
  tier: "api_only",
};

describe("MCP JSON-RPC protocol", () => {
  it("initializes with Trent server metadata and tools capability", async () => {
    const outcome = await handleMcpMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });

    expect(outcome).toMatchObject({
      kind: "response",
      body: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "trent-os" },
          capabilities: { tools: { listChanged: false } },
        },
      },
    });
    if (outcome.kind !== "response" || !outcome.body.result || typeof outcome.body.result !== "object") {
      throw new Error("expected initialize response");
    }
    const instructions = (outcome.body.result as { instructions?: string }).instructions ?? "";
    expect(instructions).toContain("trent_list_app_solo_options");
    expect(instructions).toContain("appId");
    expect(instructions).toContain("nextCall");
    expect(instructions).toContain("nextAction");
    expect(instructions).toContain("evidenceSummary");
    expect(instructions).toContain("productReview");
  });

  it("accepts notifications without a JSON-RPC response body", async () => {
    await expect(handleMcpMessage(ctx, { jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toEqual({
      kind: "accepted",
    });
  });

  it("dispatches tools/list and tools/call through injected dependencies", async () => {
    const listTools = vi.fn(() => [{
      name: "trent_company_context",
      description: "Context",
      inputSchema: { type: "object" as const },
    }]);
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "{}" }] });

    const listed = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: "l", method: "tools/list" }, { listTools, callTool });
    const called = await handleMcpMessage(ctx, {
      jsonrpc: "2.0",
      id: "c",
      method: "tools/call",
      params: { name: "trent_company_context", arguments: { verbose: true } },
    }, { listTools, callTool });

    expect(listed).toMatchObject({ kind: "response", body: { result: { tools: [{ name: "trent_company_context" }] } } });
    expect(called).toMatchObject({ kind: "response", body: { result: { content: [{ type: "text", text: "{}" }] } } });
    expect(callTool).toHaveBeenCalledWith(ctx, "trent_company_context", { verbose: true });
  });

  it("returns JSON-RPC errors for malformed requests and unknown methods", async () => {
    await expect(handleMcpMessage(ctx, { jsonrpc: "2.0", id: 2, method: "missing/nope" })).resolves.toMatchObject({
      kind: "response",
      body: { error: { code: -32601 } },
    });

    await expect(handleMcpMessage(ctx, { jsonrpc: "1.0", id: 3, method: "ping" } as never)).resolves.toMatchObject({
      kind: "response",
      body: { error: { code: -32600 } },
    });
  });
});
