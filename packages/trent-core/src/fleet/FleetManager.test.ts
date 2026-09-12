import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { AGENT_CATALOG } from "../agents/index.js";
import { SessionStore } from "../sessions/SessionStore.js";
import { FleetManager } from "./FleetManager.js";
import { CORE_ROLES } from "./AgentInstaller.js";
import { FLEET_PACKS } from "./FleetPacks.js";

describe("FleetManager", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let fleet: FleetManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    fleet = new FleetManager(configManager);
    // The shipped default config lists three agents as installed before anything is on
    // disk. Tests start from an empty fleet so counts measure what the test installed.
    const blank = configManager.loadConfig();
    blank.fleet.installed_agents = [];
    blank.fleet.active_agents = [];
    configManager.saveConfig(blank);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ catalog data

  it("exposes the real 164-specialist catalog and its 13 divisions", () => {
    const catalog = fleet.listCatalog();
    expect(catalog.length).toBe(164);

    const counts: Record<string, number> = {};
    for (const agent of catalog) counts[agent.category] = (counts[agent.category] ?? 0) + 1;

    expect(counts).toEqual({
      engineering: 29,
      design: 8,
      "paid-media": 7,
      sales: 8,
      marketing: 30,
      product: 5,
      "project-management": 6,
      testing: 8,
      support: 6,
      finance: 5,
      "spatial-computing": 6,
      academic: 5,
      specialized: 41,
    });
    expect(Object.keys(counts).length).toBe(13);
  });

  it("carries a specialist's real catalog fields through to the summary", () => {
    const summary = fleet.listAgents().find((a) => a.id === "eng-ai-engineer");
    expect(summary).toBeDefined();
    expect(summary?.name).toBe("AI Engineer");
    expect(summary?.category).toBe("engineering");
    expect(summary?.color).toBe("#06B6D4");
    expect(summary?.specialties).toBe("ML models, deployment, AI integration");

    const catalogEntry = AGENT_CATALOG.find((a) => a.id === "eng-ai-engineer");
    expect(catalogEntry?.skills).toContain("test-driven-development");
    expect(catalogEntry?.file).toBe("engineering/engineering-ai-engineer.md");
  });

  // ------------------------------------------------- defect 1: core roles in status

  it("lists the nine core roles alongside the 164 specialists", () => {
    const summaries = fleet.listAgents();
    expect(summaries.length).toBe(164 + 9);

    for (const roleId of Object.keys(CORE_ROLES)) {
      expect(summaries.some((a) => a.id === roleId)).toBe(true);
    }
  });

  it("shows an installed core role in getStatus() and counts it", () => {
    const before = fleet.getStatus();

    fleet.install("ceo");
    const status = fleet.getStatus();

    const ceo = status.agents.find((a) => a.id === "ceo");
    expect(ceo).toBeDefined();
    expect(ceo?.name).toBe("CEO Agent");
    expect(ceo?.installed).toBe(true);
    expect(ceo?.active).toBe(true);
    expect(ceo?.status).toBe("active");

    expect(status.installedCount).toBe(before.installedCount + 1);
    expect(status.activeCount).toBe(before.activeCount + 1);
  });

  // ----------------------------------------------- defect 5: real budget spend

  it("reports daily spend in integer cents from recorded usage", () => {
    expect(fleet.getStatus().dailyBudgetSpentCents).toBe(0);

    fleet.recordSpend("ceo", 250);
    fleet.recordSpend("eng-ai-engineer", 175);

    const status = fleet.getStatus();
    expect(status.dailyBudgetSpentCents).toBe(425);
    expect(status.dailyBudgetCapCents).toBe(configManager.loadConfig().budget.daily_cap);
    // Deprecated dollars view is derived, never stored.
    expect(status.dailyBudgetSpent).toBeCloseTo(4.25, 5);
  });

  it("counts today's session message costs as spend, without double counting", () => {
    const store = new SessionStore(configManager.getSessionsDir());
    const session = store.createNew("ceo", "gpt-5.6-terra", "openai");
    session.messages.push({
      id: "m1",
      role: "assistant",
      content: "done",
      timestamp: new Date().toISOString(),
      metadata: { cost_cents: 60 },
    });
    session.total_cost_cents = 60;
    store.save(session);

    expect(fleet.getStatus().dailyBudgetSpentCents).toBe(60);
    // Reading again must not accumulate the same message twice.
    expect(fleet.getStatus().dailyBudgetSpentCents).toBe(60);
  });

  it("excludes spend from previous days", () => {
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    fleet.recordSpend("ceo", 900, { at: old });
    fleet.recordSpend("ceo", 100);

    expect(fleet.getStatus().dailyBudgetSpentCents).toBe(100);
  });

  // ------------------------------------------------------------ install flows

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

  it("should deploy and undeploy core role agents", () => {
    fleet.install("support");
    expect(fleet.deploy("support")).toBe(true);
    expect(configManager.loadConfig().fleet.active_agents).toContain("support");

    fleet.undeploy("support");
    expect(configManager.loadConfig().fleet.active_agents).not.toContain("support");
  });

  it("should remove an agent from the fleet", () => {
    fleet.install("growth");
    expect(fleet.remove("growth")).toBe(true);
    expect(configManager.loadConfig().fleet.installed_agents).not.toContain("growth");
  });

  // -------------------------------------------- defect 3: pack label vs behaviour

  it("installs exactly as many agents as every pack advertises", () => {
    for (const pack of Object.values(FLEET_PACKS)) {
      const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-pack-"));
      try {
        const cm = new ConfigManager({ baseDir: packDir });
        const manager = new FleetManager(cm);
        const installed = manager.installPack(pack.id);

        expect(installed.length, `pack ${pack.id}`).toBe(pack.agents.length);
        const ids = new Set(installed.map((a) => a.id));
        for (const advertised of pack.agents) {
          expect(ids.has(advertised), `pack ${pack.id} missing ${advertised}`).toBe(true);
        }
      } finally {
        fs.rmSync(packDir, { recursive: true, force: true });
      }
    }
  });
});
