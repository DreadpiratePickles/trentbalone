import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { SessionManager } from "./SessionManager.js";

describe("SessionManager", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let sessionManager: SessionManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-test-sessions-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    sessionManager = new SessionManager(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should create and save a new session", () => {
    const session = sessionManager.startSession("engineer", "claude-sonnet-5", "anthropic");
    expect(session.id).toBeDefined();
    expect(session.agent).toBe("engineer");
    expect(session.model).toBe("claude-sonnet-5");
    expect(session.provider).toBe("anthropic");
    expect(session.messages).toHaveLength(0);

    const retrieved = sessionManager.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
  });

  it("should append messages and update total cost and duration", () => {
    const session = sessionManager.startSession("ceo");
    const msg = sessionManager.appendMessage(session.id, {
      role: "user",
      content: "Explain the architecture of Trent Fleet",
    });

    expect(msg.id).toBeDefined();
    expect(msg.content).toBe("Explain the architecture of Trent Fleet");

    sessionManager.appendMessage(session.id, {
      role: "assistant",
      agent: "ceo",
      content: "Trent Fleet is a hybrid multi-agent platform...",
      metadata: {
        cost: 0.12,
        duration_ms: 1500,
        model: "gpt-5.6-terra",
      },
    });

    const updated = sessionManager.getSession(session.id);
    expect(updated?.messages).toHaveLength(2);
    expect(updated?.total_cost).toBe(0.12);
    expect(updated?.total_duration_ms).toBe(1500);
    // Verify auto-title updated from user message
    expect(updated?.title).toContain("Explain the architecture");
  });

  it("should list sessions sorted by updated_at descending", async () => {
    const s1 = sessionManager.startSession("ceo", "gpt-5.6-terra", "openai", "First Session");
    // small wait to ensure different timestamp
    await new Promise((r) => setTimeout(r, 20));
    const s2 = sessionManager.startSession("engineer", "claude-sonnet-5", "anthropic", "Second Session");

    const list = sessionManager.listSessions();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].id).toBe(s2.id);
    expect(list[1].id).toBe(s1.id);
  });

  it("should resume the last session", async () => {
    sessionManager.startSession("ceo", "gpt-5.6-terra", "openai", "First");
    await new Promise((r) => setTimeout(r, 20));
    const latest = sessionManager.startSession("engineer", "claude-sonnet-5", "anthropic", "Latest");

    const resumed = sessionManager.resumeLastSession();
    expect(resumed?.id).toBe(latest.id);
    expect(resumed?.title).toBe("Latest");
  });

  it("should delete a session", () => {
    const s = sessionManager.startSession("support");
    expect(sessionManager.getSession(s.id)).not.toBeNull();

    const deleted = sessionManager.deleteSession(s.id);
    expect(deleted).toBe(true);
    expect(sessionManager.getSession(s.id)).toBeNull();
  });
});
