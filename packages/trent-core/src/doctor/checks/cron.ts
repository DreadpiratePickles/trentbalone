import fs from "node:fs";
import path from "node:path";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

/**
 * This check used to claim "Scheduler ready, no stuck background jobs" unconditionally. Nothing in
 * `lib/` provides a scheduler outside the eval harness, so the only honest thing to report is what
 * the on-disk scheduler state actually says — and to say plainly when there is none.
 */

const CATEGORY = "Cron";
const NAME = "Autonomous Scheduler";

/** A job whose next run is this far in the past is stuck, not merely late. */
export const OVERDUE_TOLERANCE_MS = 6 * 3600_000;

interface CronJob {
  id?: string;
  schedule?: string;
  next_run?: string;
  enabled?: boolean;
}

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

export function cronStatePath(ctx: DoctorContext): string {
  return path.join(path.dirname(ctx.configManager.getConfigPath()), "cron.json");
}

export const checkCron: DoctorCheck = {
  id: "check_cron",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const statePath = cronStatePath(ctx);

    if (!fs.existsSync(statePath)) {
      return result({
        status: "warn",
        message: `No scheduler state at ${statePath}; nothing is running scheduled jobs on this machine.`,
        fixHint: `No CLI command manages the scheduler yet. Ignore this if you do not use scheduled jobs; otherwise create ${statePath} with a top-level \`jobs\` array.`,
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
        fixHint: `Set \`enabled: true\` on a job in ${statePath}; no CLI command edits the schedule yet.`,
        details: { statePath, jobs: 0 },
      });
    }

    const now = Date.now();
    const overdue = enabled.filter((job) => {
      const next = job.next_run ? Date.parse(job.next_run) : Number.NaN;
      return Number.isFinite(next) && now - next > OVERDUE_TOLERANCE_MS;
    });
    const undated = enabled.filter((job) => !job.next_run || !Number.isFinite(Date.parse(job.next_run)));

    if (overdue.length > 0) {
      const names = overdue.map((job) => job.id ?? "unnamed").join(", ");
      return result({
        status: "warn",
        message: `${overdue.length} scheduled job(s) are overdue by more than 6 hours: ${names}. The scheduler is not draining.`,
        fixHint: `Nothing in the CLI runs the scheduler; start whatever process drains ${statePath}, then re-run \`trent doctor\`.`,
        details: { statePath, jobs: enabled.length, overdue: overdue.map((job) => job.id) },
      });
    }

    if (undated.length > 0) {
      const names = undated.map((job) => job.id ?? "unnamed").join(", ");
      return result({
        status: "warn",
        message: `${undated.length} scheduled job(s) have no valid next run time: ${names}.`,
        fixHint: "Re-register the job so the scheduler can compute its next run.",
        details: { statePath, jobs: enabled.length, undated: undated.map((job) => job.id) },
      });
    }

    return result({
      status: "ok",
      message: `${enabled.length} scheduled job(s) registered, none overdue.`,
      details: { statePath, jobs: enabled.length },
    });
  },
};
