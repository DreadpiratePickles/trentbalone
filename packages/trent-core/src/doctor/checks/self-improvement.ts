import fs from "node:fs";
import path from "node:path";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkSelfImprovement: DoctorCheck = {
  id: "check_self_improvement",
  name: "Self-Improvement Loop",
  category: "Self-Improvement",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const tracesDir = path.join(ctx.baseDir, "traces");

    try {
      if (!fs.existsSync(tracesDir)) {
        fs.mkdirSync(tracesDir, { recursive: true });
      }

      // Test write permission
      const testFile = path.join(tracesDir, ".write-test");
      fs.writeFileSync(testFile, "ok", "utf8");
      fs.unlinkSync(testFile);

      return {
        category: "Self-Improvement",
        name: "Self-Improvement Loop",
        status: "ok",
        message: `Trace store at ${tracesDir} is writable.`,
        details: { tracesDir },
      };
    } catch (err: any) {
      return {
        category: "Self-Improvement",
        name: "Self-Improvement Loop",
        status: "warn",
        message: `Trace store write check failed: ${err.message}`,
        fixHint: "Check filesystem write permissions for ~/.trent/traces.",
        autoFixable: true,
      };
    }
  },
};
