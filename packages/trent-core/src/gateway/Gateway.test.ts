import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { GatewayManager } from "./GatewayManager.js";
import { ApprovalBridge } from "./ApprovalBridge.js";

describe("GatewayManager & ApprovalBridge", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let gateway: GatewayManager;
  let bridge: ApprovalBridge;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    gateway = new GatewayManager(configManager);
    bridge = gateway.getApprovalBridge();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should list all 8 supported messaging platforms with designated agents", () => {
    const status = gateway.getStatus();
    const platformIds = Object.keys(status);
    expect(platformIds).toContain("telegram");
    expect(platformIds).toContain("discord");
    expect(platformIds).toContain("slack");
    expect(platformIds).toContain("whatsapp");
    expect(platformIds).toContain("signal");
    expect(platformIds).toContain("email");
    expect(platformIds).toContain("teams");
    expect(platformIds).toContain("homeassistant");
  });

  it("should configure custom routes per platform", () => {
    gateway.setRoute("telegram", "support-responder");
    expect(gateway.getAgentForPlatform("telegram")).toBe("support-responder");

    const reloaded = new GatewayManager(configManager);
    expect(reloaded.getAgentForPlatform("telegram")).toBe("support-responder");
  });

  it("should create, format, and decide approval requests", () => {
    const req = bridge.createApprovalRequest(
      "eng-ai-engineer",
      "Deploy to production staging",
      { commit: "abc1234", branch: "main" },
      { budgetImpact: 0.15, estimatedDurationMs: 45000 }
    );

    expect(req.id).toMatch(/^appr_/);
    expect(req.status).toBe("pending");
    expect(bridge.listPending()).toHaveLength(1);

    // Format for Telegram
    const tgCard = bridge.formatTelegramCard(req);
    expect(tgCard.text).toContain("APPROVAL REQUIRED");
    expect(tgCard.inline_keyboard[0][0].callback_data).toBe(`approve_${req.id}`);

    // Format for Slack
    const slackCard = bridge.formatSlackCard(req);
    expect(slackCard.blocks).toBeDefined();

    // Decide
    const decided = bridge.decide(req.id, "approved", "crodie");
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe("crodie");
    expect(bridge.listPending()).toHaveLength(0);
  });
});
