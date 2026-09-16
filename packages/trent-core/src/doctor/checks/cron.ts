import fs from "node:fs";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import { cronJobsPath, cronRunnerActive, cronRunnerLockPath, readCronRunnerLock } from "../../tools/cron/index.js";

/**
 * This check used to claim "Scheduler ready, no stuck background jobs" unconditionally, and then
 * read a `<profile>/cron.json` that nothing writes. The schedule the `cronjob_manage` tool and
 * the CLI's cron group share is `<profile>/cron/jobs.json`, and the process ticking it holds
 * `<profile>/cron/runner.lock`; the check reports what those two files actually say.
 */

const CATEGORY = "Cron";
const NAME = "Autonomous Scheduler";

/** A job whose next run is this far in the past is stuck, not merely late. */
export const OVERDUE_TOLERANCE_MS = 6 * 3600_000;

interface CronJob {
  id?: string;
  schedule?: string;
  next_run_at?: string;
  enabled?: boolean;
}

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

function profileDir(ctx: DoctorContext): string {
  return ctx.configManager.getProfileDir();
}

/** `<profile>/cron/jobs.json`: the one schedule file both writers share. */
export function cronStatePath(ctx: DoctorContext): string {
  return cronJobsPath(profileDir(ctx));
}

export const checkCron: DoctorCheck = {
  id: "check_cron",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const statePath = cronStatePath(ctx);
    const lockPath = cronRunnerLockPath(profileDir(ctx));

    if (!fs.existsSync(statePath)) {
      return result({
        status: "warn",
        message: `No scheduled jobs: ${statePath} does not exist, so nothing is scheduled on this machine.`,
        fixHint: "Ignore this if you do not use scheduled jobs; otherwise add one with the CLI's `cron add --schedule <cron> --prompt <text>` or ask a seat to schedule it.",
        details: { statePath, jobs: 0 },
      });
    }

    let jobs: CronJob[];
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as { jobs?: CronJob[] };
      if (!Array.isArray(parsed.jobs)) throw new Error("expected a top-level `jobs` array");
      jobs = parsed.jobs;
    } catch (err) {
      return result({
        status: "fail",
        message: `Scheduler state at ${statePath} is unreadable: ${(err as Error).message}.`,
        fixHint: `Repair the JSON in ${statePath}, or delete it to start with an empty schedule.`,
        details: { statePath },
      });
    }

    const enabled = jobs.filter((job) => job.enabled !== false);
    if (enabled.length === 0) {
      return result({
        status: "warn",
        message: `Scheduler state exists at ${statePath} but no job is enabled.`,
        fixHint: "Resume a paused job with the CLI's `cron resume <id>`, or add one with `cron add`.",
        details: { statePath, jobs: 0 },
      });
    }

    const now = Date.now();
    const overdue = enabled.filter((job) => {
      const next = job.next_run_at ? Date.parse(job.next_run_at) : Number.NaN;
      return Number.isFinite(next) && now - next > OVERDUE_TOLERANCE_MS;
    });
    const lock = readCronRunnerLock(profileDir(ctx));
    const runner = lock !== null && cronRunnerActive(profileDir(ctx)) ? lock.pid : "none";

    if (overdue.length > 0) {
      const names = overdue.map((job) => job.id ?? "unnamed").join(", ");
      return result({
        status: "warn",
        message: `${overdue.length} scheduled job(s) are overdue by more than 6 hours: ${names}. The scheduler is not draining.`,
        fixHint: runner === "none" ? "No runner holds the lock: start one with the CLI's `cron start`, then re-run `trent doctor`." : `A runner (pid ${runner}) holds ${lockPath} but is not draining; check its log and restart it.`,
        details: { statePath, lockPath, jobs: enabled.length, overdue: overdue.map((job) => job.id), runner },
      });
    }

    if (runner === "none") {
      return result({
        status: "warn",
        message: `${enabled.length} scheduled job(s) registered but no runner holds ${lockPath}; nothing will fire until one starts.`,
        fixHint: "Start the scheduler with the CLI's `cron start` (or `cron start --once` from launchd or system cron).",
        details: { statePath, lockPath, jobs: enabled.length, runner },
      });
    }

    return result({
      status: "ok",
      message: `${enabled.length} scheduled job(s) registered, none overdue; runner pid ${runner} holds the lock.`,
      details: { statePath, lockPath, jobs: enabled.length, runner },
    });
  },
};
