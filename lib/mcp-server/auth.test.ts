import { beforeEach, describe, expect, it } from "vitest";
import { registerProxyApiKey, resetProxyApiKeysForTest } from "@/lib/ai-proxy/api-keys";
import { authenticateMcpRequest } from "./auth";

describe("MCP auth boundary", () => {
  beforeEach(() => {
    resetProxyApiKeysForTest();
  });

  it("authenticates active bearer keys with the mcp scope", async () => {
    const key = registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-live",
      name: "MCP",
      scopes: ["mcp"],
      tier: "api_only",
    });

    await expect(authenticateMcpRequest("Bearer sk-trent-mcp-live")).resolves.toMatchObject({
      companyId: "company_trent_demo",
      keyId: key.keyId,
      scopes: ["mcp"],
      maskedKey: "sk-t...live",
    });
  });

  it("rejects malformed, revoked, and non-mcp keys", async () => {
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-chat-only",
      name: "Chat",
      scopes: ["chat"],
      tier: "api_only",
    });
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-revoked",
      name: "Revoked",
      scopes: ["mcp"],
      tier: "api_only",
      status: "revoked",
    });

    await expect(authenticateMcpRequest(undefined)).resolves.toBeNull();
    await expect(authenticateMcpRequest("sk-trent-chat-only")).resolves.toBeNull();
    await expect(authenticateMcpRequest("Bearer sk-trent-chat-only")).resolves.toBeNull();
    await expect(authenticateMcpRequest("Bearer sk-trent-mcp-revoked")).resolves.toBeNull();
  });

  it("requires the opt-in approval scope for approval tools", async () => {
    registerProxyApiKey({
      companyId: "company_trent_demo",
      rawKey: "sk-trent-mcp-approve",
      name: "Approver",
      scopes: ["mcp", "mcp:approve"],
      tier: "api_only",
    });

    await expect(authenticateMcpRequest("Bearer sk-trent-mcp-approve", "mcp:approve")).resolves.toMatchObject({
      scopes: ["mcp", "mcp:approve"],
    });
    await expect(authenticateMcpRequest("Bearer sk-trent-mcp-approve", "mcp")).resolves.toMatchObject({
      scopes: ["mcp", "mcp:approve"],
    });
  });
});
