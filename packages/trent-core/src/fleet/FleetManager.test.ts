import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { FleetManager } from "./FleetManager.js";
import { FLEET_PACKS } from "./FleetPacks.js";

describe("FleetManager", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let fleet: FleetManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    fleet = new FleetManager(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should list all 164 agents from the catalog", () => {
    const catalog = fleet.listCatalog();
    expect(catalog.length).toBe(164);

    const summaries = fleet.listAgents();
    expect(summaries.length).toBe(164);
  });

  it("should install an individual specialist agent", () => {
    const installed = fleet.install("eng-ai-engineer");
    expect(installed.id).toBe("eng-ai-engineer");
    expect(installed.active).toBe(true);

    const agentFile = path.join(configManager.getAgentsDir(), "eng-ai-engineer.json");
    expect(fs.existsSync(agentFile)).toBe(true);

    const status = fleet.getStatus();
    const found = status.agents.find((a) => a.id === "eng-ai-engineer");
    expect(found?.installed).toBe(true);
    expect(found?.active).toBe(true);
  });

  it("should install an entire fleet pack", () => {
    const installedList = fleet.installPack("engineering");
    expect(installedList.length).toBe(FLEET_PACKS.engineering.agents.length);
    expect(installedList.map((a) => a.id)).toContain("eng-ai-engineer");
  });

  it("should deploy and undeploy core role agents", () => {
    fleet.install("support");
    expect(fleet.deploy("support")).toBe(true);

    const config = configManager.loadConfig();
    expect(config.fleet.active_agents).toContain("support");

    fleet.undeploy("support");
    const updatedConfig = configManager.loadConfig();
    expect(updatedConfig.fleet.active_agents).not.toContain("support");
  });

  it("should remove an agent from the fleet", () => {
    fleet.install("growth");
    expect(fleet.remove("growth")).toBe(true);

    const config = configManager.loadConfig();
    expect(config.fleet.installed_agents).not.toContain("growth");
  });
});
