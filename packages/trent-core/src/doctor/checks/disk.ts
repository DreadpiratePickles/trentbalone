import fs from "node:fs";
import path from "node:path";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkDisk: DoctorCheck = {
  id: "check_disk",
  name: "Disk & Logs",
  category: "Disk",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const logsDir = path.join(ctx.baseDir, "logs");
    let logsBytes = 0;
    let logFiles = 0;

    if (fs.existsSync(logsDir)) {
      try {
        const files = fs.readdirSync(logsDir);
        for (const file of files) {
          logFiles++;
          const stat = fs.statSync(path.join(logsDir, file));
          logsBytes += stat.size;
        }
      } catch {
        // Ignore read errors
      }
    }

    const logsMb = (logsBytes / (1024 * 1024)).toFixed(1);

    if (logsBytes > 500 * 1024 * 1024) {
      return {
        category: "Disk",
        name: "Disk & Logs",
        status: "warn",
        message: `Logs directory size is large: ${logsMb} MB (${logFiles} files).`,
        fixHint: "Archive or delete old files in the logs directory yourself; `--fix` never deletes files.",
        autoFixable: false,
        details: { logsBytes, logFiles },
      };
    }

    return {
      category: "Disk",
      name: "Disk & Logs",
      status: "ok",
      message: `Log storage healthy (${logsMb} MB across ${logFiles} file${logFiles === 1 ? "" : "s"}).`,
      details: { logsBytes, logFiles },
    };
  },
};
