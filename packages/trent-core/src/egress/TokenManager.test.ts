import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenManager } from "./TokenManager.js";
import { FileTokenStore } from "./TokenStorePort.js";

const REAL_SECRET = "sk-real-openai-secret";

describe("TokenManager", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tokens-"));
    file = path.join(dir, "tokens.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("issues, resolves and revokes proxy tokens", () => {
    const manager = new TokenManager({ filePath: file });
    const token = manager.issueToken("eng-ai-engineer", { apiKey: REAL_SECRET });

    expect(token).toMatch(/^trnt_egress_[a-f0-9]{32}$/);

    const resolved = manager.resolveToken(token);
    expect(resolved?.agentId).toBe("eng-ai-engineer");
    expect(resolved?.realCredentials.apiKey).toBe(REAL_SECRET);

    expect(manager.revokeToken(token)).toBe(true);
    expect(manager.resolveToken(token)).toBeNull();
  });

  it("persists tokens across a process restart", () => {
    const first = new TokenManager({ filePath: file });
    const token = first.issueToken("ceo", { apiKey: REAL_SECRET });

    // A brand new manager over the same file stands in for a restarted process.
    const restarted = new TokenManager({ filePath: file });
    expect(restarted.resolveToken(token)?.realCredentials.apiKey).toBe(REAL_SECRET);
  });

  it("keeps a revocation across a process restart", () => {
    const first = new TokenManager({ filePath: file });
    const token = first.issueToken("ceo", { apiKey: REAL_SECRET });
    first.revokeToken(token);

    const restarted = new TokenManager({ filePath: file });
    expect(restarted.resolveToken(token)).toBeNull();
  });

  it("rejects an expired token once real time has advanced past its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const manager = new TokenManager({ filePath: file });
    const token = manager.issueToken("ceo", { apiKey: "sk-expiring" }, "terminal", 60);
    expect(manager.resolveToken(token)).not.toBeNull();

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    expect(manager.resolveToken(token)).toBeNull();

    // And it is still expired for a restarted process.
    const restarted = new TokenManager({ filePath: file });
    expect(restarted.resolveToken(token)).toBeNull();
  });

  it("revokes every token belonging to one agent", () => {
    const manager = new TokenManager({ filePath: file });
    const a = manager.issueToken("agent-a", { apiKey: "k1" });
    const b = manager.issueToken("agent-a", { apiKey: "k2" });
    const c = manager.issueToken("agent-b", { apiKey: "k3" });

    expect(manager.revokeAllForAgent("agent-a")).toBe(2);
    expect(manager.resolveToken(a)).toBeNull();
    expect(manager.resolveToken(b)).toBeNull();
    expect(manager.resolveToken(c)).not.toBeNull();
  });

  it("never exposes credentials through listActiveTokens", () => {
    const manager = new TokenManager({ filePath: file });
    manager.issueToken("ceo", { apiKey: REAL_SECRET });
    const listed = manager.listActiveTokens();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(REAL_SECRET);
  });
});

describe("FileTokenStore", () => {
  it("writes the store file with owner-only permissions", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-store-"));
    const file = path.join(dir, "nested", "tokens.json");
    const store = new FileTokenStore(file);
    store.put({
      token: "trnt_egress_" + "a".repeat(32),
      agentId: "ceo",
      realCredentials: { apiKey: "x" },
      createdAt: new Date().toISOString(),
      revoked: false,
    });

    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
