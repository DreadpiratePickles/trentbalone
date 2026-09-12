import chalk from "chalk";
import { ConfigManager } from "../config/ConfigManager.js";
import { type CheckResult, type DoctorCheck, type DoctorContext, type DoctorReport } from "./types.js";
import { checkConfig } from "./checks/config.js";
import { checkCredentials } from "./checks/credentials.js";
import { checkAgents } from "./checks/agents.js";
import { checkSkills } from "./checks/skills.js";
import { checkMcp } from "./checks/mcp.js";
import { checkConnectivity } from "./checks/connectivity.js";
import { checkDatabase } from "./checks/database.js";
import { checkCron } from "./checks/cron.js";
import { checkDisk } from "./checks/disk.js";
import { checkDependencies } from "./checks/dependencies.js";
import { checkWorkbench } from "./checks/workbench.js";
import { checkSelfImprovement } from "./checks/self-improvement.js";

export class DoctorRunner {
  private configManager: ConfigManager;
  private checks: DoctorCheck[] = [];

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
    this.registerDefaultChecks();
  }

  private registerDefaultChecks(): void {
    this.checks = [
      checkConfig,
      checkCredentials,
      checkAgents,
      checkSkills,
      checkMcp,
      checkConnectivity,
      checkDatabase,
      checkCron,
      checkDisk,
      checkDependencies,
      checkWorkbench,
      checkSelfImprovement,
    ];
  }

  public registerCheck(check: DoctorCheck): void {
    this.checks.push(check);
  }

  public async runAll(): Promise<DoctorReport> {
    const context: DoctorContext = {
      baseDir: this.configManager.getBaseDir(),
      profile: this.configManager.getProfile(),
      configManager: this.configManager,
    };

    const results: CheckResult[] = [];

    for (const check of this.checks) {
      try {
        const result = await check.run(context);
        results.push(result);
      } catch (err: any) {
        results.push({
          category: check.category,
          name: check.name,
          status: "error",
          message: `Check execution failed: ${err.message}`,
          auto_fixable: false,
        });
      }
    }

    const passed = results.filter((r) => r.status === "ok").length;
    const warnings = results.filter((r) => r.status === "warn").length;
    const errors = results.filter((r) => r.status === "error").length;

    return {
      timestamp: new Date().toISOString(),
      total: results.length,
      passed,
      warnings,
      errors,
      results,
    };
  }

  public formatReport(report: DoctorReport): string {
    const lines: string[] = [];

    for (const res of report.results) {
      let icon = chalk.green("✓");
      if (res.status === "warn") icon = chalk.yellow("⚠");
      if (res.status === "error") icon = chalk.red("✗");

      const categoryPad = res.category.padEnd(16, " ");
      lines.push(`${icon} ${chalk.bold(categoryPad)} ${res.message}`);

      if ((res.status === "warn" || res.status === "error") && res.fix_hint) {
        lines.push(`  ${chalk.dim("↳ Hint:")} ${chalk.italic(res.fix_hint)}`);
      }
    }

    lines.push("");
    if (report.errors === 0 && report.warnings === 0) {
      lines.push(chalk.green.bold("All 12 diagnostics passed! Fleet system is fully operational."));
    } else {
      const summaryParts = [];
      if (report.errors > 0) {
        summaryParts.push(chalk.red.bold(`${report.errors} error${report.errors === 1 ? "" : "s"}`));
      }
      if (report.warnings > 0) {
        summaryParts.push(chalk.yellow.bold(`${report.warnings} warning${report.warnings === 1 ? "" : "s"}`));
      }
      lines.push(`${summaryParts.join(", ")} found.`);
      lines.push(chalk.cyan("Run `trent doctor --fix` for automated remediation of eligible items."));
    }

    return lines.join("\n");
  }

  public async fixAll(): Promise<void> {
    this.configManager.ensureDirs();
    if (!this.configManager.exists()) {
      this.configManager.saveConfig(this.configManager.loadConfig());
    }
  }
}
