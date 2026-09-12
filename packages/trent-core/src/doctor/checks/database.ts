import fs from "node:fs";
import path from "node:path";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkDatabase: DoctorCheck = {
  id: "check_database",
  name: "Database & State Store",
  category: "Database",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const sessionsDir = ctx.configManager.getSessionsDir();

    if (!fs.existsSync(sessionsDir)) {
      return {
        category: "Database",
        name: "Database & State Store",
        status: "ok",
        message: "State directory ready (0 active sessions).",
        details: { sessions: 0, sizeBytes: 0 },
      };
    }

    try {
      const files = fs.readdirSync(sessionsDir);
      let sessionCount = 0;
      let totalBytes = 0;
      let corruptedCount = 0;

      for (const file of files) {
        if (file.endsWith(".json")) {
          sessionCount++;
          const fullPath = path.join(sessionsDir, file);
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
          try {
            JSON.parse(fs.readFileSync(fullPath, "utf8"));
          } catch {
            corruptedCount++;
          }
        }
      }

      if (corruptedCount > 0) {
        return {
          category: "Database",
          name: "Database & State Store",
          status: "warn",
          message: `${corruptedCount} corrupted session file(s) detected out of ${sessionCount}.`,
          fix_hint: "Run `trent doctor --fix` to clean up unreadable session files.",
          auto_fixable: true,
          details: { sessionCount, corruptedCount, totalBytes },
        };
      }

      const sizeKb = (totalBytes / 1024).toFixed(1);
      return {
        category: "Database",
        name: "Database & State Store",
        status: "ok",
        message: `Local state store healthy (${sessionCount} session${sessionCount === 1 ? "" : "s"}, ${sizeKb} KB).`,
        details: { sessionCount, totalBytes },
      };
    } catch (err: any) {
      return {
        category: "Database",
        name: "Database & State Store",
        status: "error",
        message: `State store error: ${err.message}`,
        fix_hint: "Verify filesystem permissions for ~/.trent/sessions/.",
        auto_fixable: false,
      };
    }
  },
};
