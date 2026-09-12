import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { SetupWizard } from "./SetupWizard.js";

describe("SetupWizard", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let wizard: SetupWizard;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-setup-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    wizard = new SetupWizard(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should execute quick setup mode", async () => {
    const res = await wizard.run({
      mode: "quick",
      provider: "openai",
      apiKey: "sk-test-quick",
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe("quick");
    expect(res.config.fleet.installed_agents).toEqual([
      "ceo",
      "eng-ai-engineer",
      "support-responder",
    ]);
    expect(res.config.toolsets).toContain("web");
    expect(res.secretsConfigured).toContain("OPENAI_API_KEY");

    const reloaded = configManager.loadConfig();
    expect(reloaded.provider).toBe("openai");
  });

  it("should execute blank-slate setup mode with explicitly disabled toolsets", async () => {
    const res = await wizard.run({
      mode: "blank-slate",
      provider: "anthropic",
      apiKey: "sk-ant-test",
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe("blank-slate");
    expect(res.config.toolsets).toEqual(["file_ops", "terminal"]);
    expect(res.config.disabled_toolsets).toContain("web");
    expect(res.config.disabled_toolsets).toContain("browser");
    expect(res.config.disabled_toolsets).toContain("skills");
    expect(res.config.fleet.installed_agents).toEqual(["ceo"]);
  });

  it("should execute full setup mode with custom settings", async () => {
    const res = await wizard.run({
      mode: "full",
      provider: "google",
      model: "gemini-2.5-pro",
      dailyBudget: 25.0,
      agents: ["ceo", "eng-ai-engineer", "data-analyst"],
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe("full");
    expect(res.config.provider).toBe("google");
    expect(res.config.model).toBe("gemini-2.5-pro");
    expect(res.config.budget.daily_cap).toBe(25.0);
    expect(res.config.fleet.installed_agents).toContain("data-analyst");
  });
});
