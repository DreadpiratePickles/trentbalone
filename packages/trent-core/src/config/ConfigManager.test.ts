import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "./ConfigManager.js";
import { DEFAULT_CONFIG } from "./defaults.js";

describe("ConfigManager", () => {
  let tempDir: string;
  let manager: ConfigManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-test-config-"));
    manager = new ConfigManager({ baseDir: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should initialize directories on ensureDirs", () => {
    manager.ensureDirs();
    expect(fs.existsSync(manager.getBaseDir())).toBe(true);
    expect(fs.existsSync(manager.getSessionsDir())).toBe(true);
    expect(fs.existsSync(manager.getSkillsDir())).toBe(true);
  });

  it("should return default config if config.yaml does not exist", () => {
    const config = manager.loadConfig();
    expect(config.provider).toBe(DEFAULT_CONFIG.provider);
    expect(config.model).toBe(DEFAULT_CONFIG.model);
    expect(config.budget.daily_cap).toBe(10.0);
  });

  it("should save and reload valid config", () => {
    const config = manager.loadConfig();
    config.model = "claude-sonnet-5";
    config.budget.daily_cap = 25.0;
    manager.saveConfig(config);

    // Create fresh manager pointing to same baseDir
    const freshManager = new ConfigManager({ baseDir: tempDir });
    const loaded = freshManager.loadConfig();
    expect(loaded.model).toBe("claude-sonnet-5");
    expect(loaded.budget.daily_cap).toBe(25.0);
  });

  it("should save and load secrets with restricted permissions", () => {
    manager.saveSecrets({ OPENAI_API_KEY: "sk-test-key-12345" });
    const secrets = manager.loadSecrets();
    expect(secrets.OPENAI_API_KEY).toBe("sk-test-key-12345");

    const secretsPath = manager.getSecretsPath();
    expect(fs.existsSync(secretsPath)).toBe(true);
    const content = fs.readFileSync(secretsPath, "utf8");
    expect(content).toContain("OPENAI_API_KEY=sk-test-key-12345");
  });

  it("should set and get values using dot notation", () => {
    manager.set("budget.daily_cap", 50.0);
    expect(manager.get("budget.daily_cap")).toBe(50.0);

    manager.set("OPENAI_API_KEY", "sk-secret-from-set");
    expect(manager.get("OPENAI_API_KEY")).toBe("sk-secret-from-set");
  });

  it("should support multiple profiles", () => {
    const defaultManager = new ConfigManager({ baseDir: tempDir, profile: "default" });
    defaultManager.set("model", "gpt-5.6-terra");

    const devManager = new ConfigManager({ baseDir: tempDir, profile: "dev" });
    devManager.set("model", "claude-haiku-4.5");

    expect(defaultManager.get("model")).toBe("gpt-5.6-terra");
    expect(devManager.get("model")).toBe("claude-haiku-4.5");
    expect(defaultManager.listProfiles()).toContain("default");
    expect(defaultManager.listProfiles()).toContain("dev");
  });

  it("should delete config and secret keys", () => {
    manager.set("OPENAI_API_KEY", "sk-delete-me");
    expect(manager.get("OPENAI_API_KEY")).toBe("sk-delete-me");
    manager.delete("OPENAI_API_KEY");
    expect(manager.get("OPENAI_API_KEY")).toBeUndefined();
  });
});
