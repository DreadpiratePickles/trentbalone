import chalk from "chalk";
import { ConfigManager } from "../config/ConfigManager.js";
import { EXIT, type ExitCode } from "../errors/index.js";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  timedOut,
  withDeadline,
} from "./probe.js";
import type {
  CheckResult,
  DoctorCheck,
  DoctorContext,
  DoctorMode,
  DoctorReport,
  ExecLike,
  FetchLike,
} from "./types.js";
import { checkConfig } from "./checks/config.js";
import { checkCredentials } from "./checks/credentials.js";
import { checkEnvironment } from "./checks/environment.js";
import { checkAgents } from "./checks/agents.js";
import { checkSkills } from "./checks/skills.js";
import { checkMcp } from "./checks/mcp.js";
import { checkConnectivity } from "./checks/connectivity.js";
import { checkDatabase } from "./checks/database.js";
import { checkCron } from "./checks/cron.js";
import { checkEgressRoot } from "./checks/egress-ca.js";
import { checkDisk } from "./checks/disk.js";
import { checkDependencies } from "./checks/dependencies.js";
import { checkWorkbench } from "./checks/workbench.js";
import { checkSelfImprovement } from "./checks/self-improvement.js";
import { checkTelemetry } from "./checks/telemetry.js";
import { checkEmbedder } from "./checks/embedder.js";
import { checkBrain } from "./checks/brain.js";
// [C1] app memory
import { checkAppMemory } from "./checks/app-memory.js";

export interface DoctorRunnerOptions {
  checks?: DoctorCheck[];
  /** Deadline for one outbound request inside a check. */
  probeTimeoutMs?: number;
  /** Deadline for one whole check. A wedged check reports as a timeout instead of hanging. */
  checkTimeoutMs?: number;
  /** Deadline for the entire run. Whatever has not run by then reports as a timeout. */
  totalTimeoutMs?: number;
  mode?: DoctorMode;
  healthUrl?: string;
  fetchImpl?: FetchLike;
  execImpl?: ExecLike;
  /**
   * Where `--fix` states a destructive action BEFORE performing it. Defaults to stderr, so a
   * deletion is never silent even when nothing passes a sink.
   */
  announce?: (line: string) => void;
}

export const DEFAULT_CHECKS: readonly DoctorCheck[] = [
  checkConfig,
  checkCredentials,
  checkEnvironment,
  checkAgents,
  checkSkills,
  checkMcp,
  checkConnectivity,
  checkDatabase,
  checkCron,
  checkEgressRoot,
  checkDisk,
  checkDependencies,
  checkWorkbench,
  checkSelfImprovement,
  checkTelemetry,
  checkEmbedder,
  checkBrain,
  // [C1] app memory
  checkAppMemory,
];

/** 3 (config) when any check failed; 0 when everything passed or only warned. */
export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.errors > 0 ? EXIT.CONFIG : EXIT.OK;
}

/** The machine-readable report an installer or CI job consumes. */
export function renderJsonReport(report: DoctorReport): string {
  return JSON.stringify({ ...report, exitCode: doctorExitCode(report) }, null, 2);
}

export class DoctorRunner {
  private readonly configManager: ConfigManager;
  private readonly options: DoctorRunnerOptions;
  private checks: DoctorCheck[];

  constructor(configManager?: ConfigManager, options: DoctorRunnerOptions = {}) {
    this.configManager = configManager ?? new ConfigManager();
    this.options = options;
    this.checks = [...(options.checks ?? DEFAULT_CHECKS)];
  }

  public registerCheck(check: DoctorCheck): void {
    this.checks.push(check);
  }

  public listChecks(): readonly DoctorCheck[] {
    return this.checks;
  }

  private context(): DoctorContext {
    return {
      baseDir: this.configManager.getBaseDir(),
      profile: this.configManager.getProfile(),
      configManager: this.configManager,
      probeTimeoutMs: this.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      fetchImpl: this.options.fetchImpl,
      execImpl: this.options.execImpl,
      mode: this.options.mode,
      healthUrl: this.options.healthUrl,
    };
  }

  public async runAll(): Promise<DoctorReport> {
    const context = this.context();
    const checkTimeoutMs = this.options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const totalTimeoutMs = this.options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    const startedAt = Date.now();
    const results: CheckResult[] = [];

    for (const check of this.checks) {
      // The per-call AbortSignal is not a deadline: a library is free to ignore it. The run is
      // therefore bounded twice, once per check and once overall, by timers we own.
      const remaining = totalTimeoutMs - (Date.now() - startedAt);
      const budget = Math.min(checkTimeoutMs, Math.max(remaining, 0));

      if (budget <= 0) {
        results.push(this.timeoutResult(check, totalTimeoutMs, true));
        continue;
      }

      try {
        const outcome = await withDeadline(() => check.run(context), budget);
        results.push(timedOut(outcome) ? this.timeoutResult(check, budget, false) : outcome);
      } catch (err) {
        results.push({
          category: check.category,
          name: check.name,
          status: "fail",
          message: `Check threw before producing a result: ${(err as Error).message}`,
          fixHint: "This is a bug in the check itself; re-run with TRENT_DEBUG=1 and report it.",
        });
      }
    }

    const passed = results.filter((r) => r.status === "ok").length;
    const warnings = results.filter((r) => r.status === "warn").length;
    const errors = results.filter((r) => r.status === "fail" || r.status === "error").length;
    const skipped = results.filter((r) => r.status === "skip").length;

    return {
      timestamp: new Date().toISOString(),
      total: results.length,
      passed,
      warnings,
      errors,
      skipped,
      durationMs: Date.now() - startedAt,
      results,
    };
  }

  private timeoutResult(check: DoctorCheck, budgetMs: number, runDeadline: boolean): CheckResult {
    return {
      category: check.category,
      name: check.name,
      status: "fail",
      message: runDeadline
        ? `Check did not run: the doctor's overall deadline of ${budgetMs}ms timed out first.`
        : `Check timed out after ${budgetMs}ms and was abandoned.`,
      fixHint: "Re-run with a longer deadline, or investigate why this check cannot complete.",
      details: { timeoutMs: budgetMs },
    };
  }

  /** Plain-text report. No emoji anywhere: the brand rule forbids them in output. */
  public formatReport(report: DoctorReport): string {
    const lines: string[] = [];

    for (const res of report.results) {
      const marker =
        res.status === "ok"
          ? chalk.green("[ ok ]")
          : res.status === "warn"
            ? chalk.yellow("[warn]")
            : res.status === "skip"
              ? chalk.dim("[skip]")
              : chalk.red("[fail]");

      lines.push(`${marker} ${chalk.bold(res.category.padEnd(16, " "))} ${res.message}`);
      if (res.status !== "ok" && res.status !== "skip" && res.fixHint) {
        lines.push(`       ${chalk.dim("fix:")} ${res.fixHint}`);
      }
    }

    lines.push("");
    lines.push(
      `${report.passed} passed, ${report.warnings} warning(s), ${report.errors} failure(s), ${report.skipped} skipped in ${report.durationMs}ms.`,
    );
    if (report.errors > 0 || report.warnings > 0) {
      lines.push(chalk.cyan("Run `trent doctor --fix` to apply the safe automatic remediations."));
    }

    return lines.join("\n");
  }
}
