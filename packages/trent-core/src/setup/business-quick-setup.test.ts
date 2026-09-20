/**
 * Quick setup and the `business` toolset: on only when `trent connect` holds at least one of
 * its providers (Stripe, Google, Square, Twilio), off — and written off explicitly — otherwise,
 * so a later `trent update` cannot switch it on unasked. The probe is injected exactly as the
 * media backend probe is, so no secrets file is read here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../config/index.js";
import { CollectingOutput } from "./ports.js";
import { ScriptedPrompts } from "./ScriptedPrompts.js";
import { SetupWizard } from "./SetupWizard.js";

let tempDir: string;
let configManager: ConfigManager;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-setup-business-"));
  configManager = new ConfigManager({ baseDir: tempDir });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function configOnDisk(): { toolsets: string[]; disabled_toolsets: string[] } {
  return parseYaml(fs.readFileSync(configManager.getConfigPath(), "utf8")) as { toolsets: string[]; disabled_toolsets: string[] };
}

describe("quick setup and the business toolset", () => {
  it("leaves business off, explicitly, when no business provider is connected", async () => {
    const output = new CollectingOutput();
    const wizard = new SetupWizard({ configManager, prompts: new ScriptedPrompts({ confirm: true }), output, env: { ANTHROPIC_API_KEY: "sk-ant-live" }, mediaBackendPresent: async () => true, businessProviderConnected: () => false });
    expect((await wizard.run({ mode: "quick" })).success).toBe(true);
    expect(configOnDisk().toolsets).not.toContain("business");
    expect(configOnDisk().disabled_toolsets).toContain("business");
    expect(output.lines.join("\n")).toMatch(/business.*trent connect/);
  });

  it("turns business on when at least one provider is connected", async () => {
    const output = new CollectingOutput();
    const wizard = new SetupWizard({ configManager, prompts: new ScriptedPrompts({ confirm: true }), output, env: { ANTHROPIC_API_KEY: "sk-ant-live" }, mediaBackendPresent: async () => true, businessProviderConnected: () => true });
    expect((await wizard.run({ mode: "quick" })).success).toBe(true);
    expect(configOnDisk().toolsets).toContain("business");
    expect(configOnDisk().disabled_toolsets).not.toContain("business");
  });
});
