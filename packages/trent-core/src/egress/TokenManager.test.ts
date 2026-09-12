import { describe, it, expect } from "vitest";
import { TokenManager } from "./TokenManager.js";

describe("TokenManager & Egress", () => {
  it("should issue, resolve, and revoke proxy tokens", () => {
    const manager = new TokenManager();
    const token = manager.issueToken("eng-ai-engineer", {
      apiKey: "sk-real-openai-secret",
    });

    expect(token).toMatch(/^trnt_egress_[a-f0-9]{32}$/);

    const resolved = manager.resolveToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.agentId).toBe("eng-ai-engineer");
    expect(resolved?.realCredentials.apiKey).toBe("sk-real-openai-secret");

    // Revoke
    manager.revokeToken(token);
    expect(manager.resolveToken(token)).toBeNull();
  });

  it("should enforce token expiration TTL", async () => {
    const manager = new TokenManager();
    const token = manager.issueToken(
      "ceo",
      { apiKey: "sk-expiring" },
      "terminal",
      1 // 1 second TTL
    );

    expect(manager.resolveToken(token)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1100));
    expect(manager.resolveToken(token)).toBeNull();
  });
});
