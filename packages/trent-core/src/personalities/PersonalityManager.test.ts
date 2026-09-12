import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { PersonalityManager } from "./PersonalityManager.js";
import { BUILTIN_PERSONALITIES } from "./built-in.js";

describe("PersonalityManager", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let manager: PersonalityManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-persona-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    manager = new PersonalityManager(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should list all 6 built-in personalities", () => {
    const list = manager.list();
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(list.map((p) => p.name)).toContain("pirate");
    expect(list.map((p) => p.name)).toContain("professional");
    expect(list.map((p) => p.name)).toContain("casual");
    expect(list.map((p) => p.name)).toContain("robot");
    expect(list.map((p) => p.name)).toContain("coach");
    expect(list.map((p) => p.name)).toContain("default");
  });

  it("should switch personality and persist to config", () => {
    const pirate = manager.setPersonality("pirate");
    expect(pirate.name).toBe("pirate");

    const active = manager.getActivePersonality();
    expect(active.name).toBe("pirate");

    const reloaded = configManager.loadConfig();
    expect(reloaded.personality).toBe("pirate");
  });

  it("should apply personality suffix to prompt", () => {
    const base = "You are an autonomous coding assistant.";
    const piratePrompt = manager.applyToPrompt(base, "pirate");
    expect(piratePrompt).toContain("Ahoy");
    expect(piratePrompt).toContain("pirate");

    const robotPrompt = manager.applyToPrompt(base, "robot");
    expect(robotPrompt).toContain("deterministic mechanical intelligence unit");
  });
});
