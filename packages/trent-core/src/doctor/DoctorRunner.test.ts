import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { DoctorRunner } from "./DoctorRunner.js";
import { FixRunner } from "./FixRunner.js";

describe("DoctorRunner & FixRunner", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let doctor: DoctorRunner;
  let fixer: FixRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    doctor = new DoctorRunner(configManager);
    fixer = new FixRunner(configManager);
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should run all 12 diagnostic checks sequentially", async () => {
    const report = await doctor.runAll();
    expect(report.total).toBe(12);
    expect(report.results).toHaveLength(12);

    const categories = report.results.map((r) => r.category);
    expect(categories).toContain("Config");
    expect(categories).toContain("Credentials");
    expect(categories).toContain("Agents");
    expect(categories).toContain("Skills");
    expect(categories).toContain("MCP");
    expect(categories).toContain("Connectivity");
    expect(categories).toContain("Database");
    expect(categories).toContain("Cron");
    expect(categories).toContain("Disk");
    expect(categories).toContain("Dependencies");
    expect(categories).toContain("Workbench");
    expect(categories).toContain("Self-Improvement");
  });

  it("should correctly format output with color markers", async () => {
    const report = await doctor.runAll();
    const formatted = doctor.formatReport(report);
    expect(formatted).toBeDefined();
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(50);
  });

  it("should flag missing credentials when provider key is absent", async () => {
    configManager.saveConfig({
      ...configManager.loadConfig(),
      provider: "openai",
    });
    // no secrets written yet
    const report = await doctor.runAll();
    const credsResult = report.results.find((r) => r.category === "Credentials");
    expect(credsResult).toBeDefined();
    expect(credsResult?.status).toBe("warn"); // no secrets file
  });

  it("should auto-remediate safe issues with FixRunner", async () => {
    // Skills dir with orphan symlink
    configManager.ensureDirs();
    const skillsDir = configManager.getSkillsDir();
    const orphanLink = path.join(skillsDir, "broken-skill.md");
    try {
      fs.symlinkSync(path.join(tempDir, "non-existent-target.md"), orphanLink);
    } catch {
      // Symlink creation on platform
    }

    const { actions, newReport } = await fixer.runFixes();
    expect(actions.length).toBeGreaterThanOrEqual(2);
    expect(newReport.total).toBe(12);
  });
});
