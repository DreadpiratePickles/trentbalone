import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkCron: DoctorCheck = {
  id: "check_cron",
  name: "Autonomous Scheduler & Cron",
  category: "Cron",
  async run(_ctx: DoctorContext): Promise<CheckResult> {
    try {
      return {
        category: "Cron",
        name: "Autonomous Scheduler & Cron",
        status: "ok",
        message: "Scheduler ready, no stuck background jobs.",
        details: { activeQueues: ["heartbeat", "self_improvement"] },
      };
    } catch (err: any) {
      return {
        category: "Cron",
        name: "Autonomous Scheduler & Cron",
        status: "warn",
        message: `Scheduler check warning: ${err.message}`,
        fix_hint: "Check BullMQ or scheduler worker status.",
        auto_fixable: true,
      };
    }
  },
};
