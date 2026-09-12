import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { DoctorRunner } from "./DoctorRunner.js";
import type { DoctorReport } from "./types.js";

export interface FixAction {
  category: string;
  action: string;
  success: boolean;
  message: string;
}

export class FixRunner {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public async runFixes(): Promise<{ actions: FixAction[]; newReport: DoctorReport }> {
    const actions: FixAction[] = [];

    // 1. Ensure directories exist
    try {
      this.configManager.ensureDirs();
      actions.push({
        category: "Config",
        action: "ensure_directories",
        success: true,
        message: "Created any missing ~/.trent directories.",
      });
    } catch (err: any) {
      actions.push({
        category: "Config",
        action: "ensure_directories",
        success: false,
        message: `Failed to create directories: ${err.message}`,
      });
    }

    // 2. Safe config remediation
    try {
      const configPath = this.configManager.getConfigPath();
      if (!fs.existsSync(configPath)) {
        const def = this.configManager.loadConfig();
        this.configManager.saveConfig(def);
        actions.push({
          category: "Config",
          action: "populate_default_config",
          success: true,
          message: "Initialized ~/.trent/config.yaml with default settings.",
        });
      }
    } catch (err: any) {
      actions.push({
        category: "Config",
        action: "populate_default_config",
        success: false,
        message: `Failed to fix config: ${err.message}`,
      });
    }

    // 3. Clean orphan skill symlinks
    try {
      const skillsDir = this.configManager.getSkillsDir();
      if (fs.existsSync(skillsDir)) {
        const entries = fs.readdirSync(skillsDir);
        let removed = 0;
        for (const entry of entries) {
          const fullPath = path.join(skillsDir, entry);
          try {
            const stat = fs.lstatSync(fullPath);
            if (stat.isSymbolicLink() && !fs.existsSync(fullPath)) {
              fs.unlinkSync(fullPath);
              removed++;
            }
          } catch {
            // Ignore
          }
        }
        if (removed > 0) {
          actions.push({
            category: "Skills",
            action: "clean_orphan_symlinks",
            success: true,
            message: `Removed ${removed} broken/orphan skill symlink(s).`,
          });
        }
      }
    } catch (err: any) {
      actions.push({
        category: "Skills",
        action: "clean_orphan_symlinks",
        success: false,
        message: `Failed to clean skills: ${err.message}`,
      });
    }

    // 4. Archive corrupted session files safely (never permanently delete user data)
    try {
      const sessionsDir = this.configManager.getSessionsDir();
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir);
        let archived = 0;
        const backupDir = path.join(sessionsDir, ".corrupted_archive");

        for (const file of files) {
          if (file.endsWith(".json")) {
            const fullPath = path.join(sessionsDir, file);
            try {
              JSON.parse(fs.readFileSync(fullPath, "utf8"));
            } catch {
              if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
              }
              fs.renameSync(fullPath, path.join(backupDir, file));
              archived++;
            }
          }
        }
        if (archived > 0) {
          actions.push({
            category: "Database",
            action: "archive_corrupted_sessions",
            success: true,
            message: `Safely quarantined ${archived} corrupted session file(s) into .corrupted_archive/ (no data deleted).`,
          });
        }
      }
    } catch (err: any) {
      actions.push({
        category: "Database",
        action: "archive_corrupted_sessions",
        success: false,
        message: `Failed to quarantine corrupted sessions: ${err.message}`,
      });
    }

    // Run doctor again after remediation to verify new state
    const runner = new DoctorRunner(this.configManager);
    const newReport = await runner.runAll();

    return { actions, newReport };
  }
}
