import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { VoiceManager } from "./VoiceManager.js";

describe("VoiceManager", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let voiceManager: VoiceManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-voice-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    voiceManager = new VoiceManager(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should initialize with voice disabled by default", () => {
    expect(voiceManager.isEnabled()).toBe(false);
  });

  it("should toggle voice mode on and persist to config", async () => {
    const enabled = await voiceManager.toggle(true);
    expect(enabled).toBe(true);
    expect(voiceManager.isEnabled()).toBe(true);

    const config = configManager.loadConfig();
    expect(config.voice.enabled).toBe(true);

    await voiceManager.toggle(false);
    expect(voiceManager.isEnabled()).toBe(false);
  });
});
