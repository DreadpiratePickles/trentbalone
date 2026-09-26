/**
 * [C11.2] New profiles run solo; existing profiles keep what they had; the fleet stays as the team.
 *
 * The council's rule (02_plan/output/hermes-council-verdict-2026-09-26.md §7 item 4) is met: the 9B solo-format
 * smoke scored 4/5 (docs/local-models.md, "Solo on this machine"). So setup writes `agent.mode: solo` into a
 * profile it creates, unless the user chose the fleet (`fleet: true`, the `--team`/`--fleet` flag). A profile
 * that already has a config keeps its mode, and one without the key still runs the fleet (`agentMode`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigManager } from "../config/index.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { DEFAULT_AGENT_MODE, NEW_PROFILE_AGENT_MODE, agentMode } from "../config/sections/agent.js";
import { SetupWizard } from "./SetupWizard.js";
import { ScriptedPrompts } from "./ScriptedPrompts.js";
import { CollectingOutput } from "./ports.js";
import { createLocalDiscovery } from "./local-detect.js";
import { createLocalRuntime } from "./local-runtime.js";
import { CHAT_CAPS, fakeLocal } from "./local-fakes.test-helpers.js";
import type { SetupOptions } from "./types.js";

const GIB = 1024 ** 3;
const NINE_B = { name: "qwen3.5:9b", capabilities: [...CHAT_CAPS] };
const NOTHING_LOCAL = fakeLocal({});
const KEY = { GEMINI_API_KEY: "test-value-not-a-secret" };

let dir: string;
let manager: ConfigManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-default-"));
  manager = new ConfigManager({ baseDir: dir });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function onDisk(): Record<string, any> {
  return parseYaml(fs.readFileSync(manager.getConfigPath(), "utf8")) as Record<string, any>;
}

async function setup(options: SetupOptions, answers: Record<string, unknown> = {}, local = NOTHING_LOCAL) {
  const prompts = new ScriptedPrompts({ confirm: true, api_key_entry: false, walkthrough: false, ...answers });
  const output = new CollectingOutput();
  const wizard = new SetupWizard({
    configManager: manager,
    prompts,
    output,
    env: KEY,
    localRuntime: createLocalRuntime({ fetch: local.fetch }),
    localDiscovery: createLocalDiscovery({ fetch: local.fetch }),
    dockerPresent: async () => true,
    mediaBackendPresent: async () => false,
    totalMemoryBytes: 16 * GIB,
  });
  const result = await wizard.run(options);
  // A fresh manager, so what is asserted is the file, not the wizard's cache.
  manager = new ConfigManager({ baseDir: dir });
  return { result, prompts, output };
}

/** A profile written before C11.2: a config on disk with no `agent.mode`. */
function existingFleetProfile(): void {
  const { mode: _mode, ...agent } = { ...(DEFAULT_CONFIG.agent as Record<string, unknown>) };
  manager.saveConfig({ ...manager.loadConfig(), provider: "google", model: "gemini-3.5-flash-lite", agent } as ReturnType<ConfigManager["loadConfig"]>);
  expect(onDisk().agent?.mode).toBeUndefined();
  manager = new ConfigManager({ baseDir: dir });
}

describe("[C11.2] the default for a new profile is solo; a profile without the key is still the fleet", () => {
  it("names both defaults in one place: solo for what setup writes, fleet for a profile without the key", () => {
    expect(NEW_PROFILE_AGENT_MODE).toBe("solo");
    expect(DEFAULT_AGENT_MODE).toBe("fleet");
    expect((DEFAULT_CONFIG.agent as { mode?: string }).mode).toBeUndefined();
  });

  it("an existing config without agent.mode still resolves to the fleet", () => {
    existingFleetProfile();
    expect(agentMode(manager.loadConfig())).toBe("fleet");
  });
});

describe("[C11.2] quick setup", () => {
  it("writes agent.mode: solo explicitly into a new profile", async () => {
    const { result } = await setup({ mode: "quick" });
    expect(result.success).toBe(true);
    expect(onDisk().agent.mode).toBe("solo");
  });

  it("writes the fleet when the user chose it", async () => {
    await setup({ mode: "quick", fleet: true });
    expect(onDisk().agent.mode).toBe("fleet");
  });

  it("leaves an existing profile's mode alone: no key stays no key, and that is the fleet", async () => {
    existingFleetProfile();
    await setup({ mode: "quick" });
    expect(onDisk().agent?.mode).toBeUndefined();
    expect(agentMode(manager.loadConfig())).toBe("fleet");
  });

  it("the first-run screen describes the two modes in one line each, naming the fleet as the option", async () => {
    const { output } = await setup({ mode: "quick" });
    const solo = output.lines.filter((line) => /^\s*solo\b/i.test(line));
    const team = output.lines.filter((line) => /^\s*team\b/i.test(line));
    expect(solo).toHaveLength(1);
    expect(team).toHaveLength(1);
    expect(solo[0]).toMatch(/one agent/);
    expect(team[0]).toMatch(/fleet/);
    expect(team[0]).toMatch(/option/);
    expect(team[0]).toMatch(/nine/);
    expect(team[0]).toMatch(/--team/);
    expect(output.lines.join("\n")).not.toMatch(/164|specialists/);
  });
});

describe("[C11.2] full setup", () => {
  it("asks for the mode, pre-filled with solo on a new profile, and writes it", async () => {
    const { prompts } = await setup({ mode: "full" });
    expect(prompts.asked.map((q) => q.id)).toContain("agent_mode");
    expect(onDisk().agent.mode).toBe("solo");
  });

  it("writes the fleet when the user answers fleet", async () => {
    await setup({ mode: "full" }, { agent_mode: "fleet" });
    expect(onDisk().agent.mode).toBe("fleet");
  });

  it("pre-fills an existing profile's own runner, so pressing enter keeps it on the fleet", async () => {
    existingFleetProfile();
    await setup({ mode: "full" });
    expect(agentMode(manager.loadConfig())).toBe("fleet");
  });

  it("asks nothing about the mode when the user chose it with a flag", async () => {
    const { prompts } = await setup({ mode: "full", fleet: true });
    expect(prompts.asked.map((q) => q.id)).not.toContain("agent_mode");
    expect(onDisk().agent.mode).toBe("fleet");
  });
});

describe("[C11.2] blank slate and local setup", () => {
  it("blank slate writes solo into a new profile", async () => {
    await setup({ mode: "blank-slate", provider: "google", model: "gemini-3.5-flash-lite" });
    expect(onDisk().agent.mode).toBe("solo");
  });

  it("local mode writes solo into a new profile, and the fleet when it was chosen", async () => {
    const local = fakeLocal({ ollama: { models: [NINE_B] } });
    await setup({ mode: "local" }, {}, local);
    expect(onDisk().agent.mode).toBe("solo");
    fs.rmSync(dir, { recursive: true, force: true });
    manager = new ConfigManager({ baseDir: dir });
    await setup({ mode: "local", fleet: true }, {}, local);
    expect(onDisk().agent.mode).toBe("fleet");
  });
});
