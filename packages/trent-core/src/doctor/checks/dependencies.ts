import { execSync } from "node:child_process";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkDependencies: DoctorCheck = {
  id: "check_dependencies",
  name: "System Binaries",
  category: "Dependencies",
  async run(_ctx: DoctorContext): Promise<CheckResult> {
    const required = ["git", "node", "npm"];
    const optional = ["docker"];
    const missingRequired: string[] = [];
    const available: Record<string, string> = {};

    for (const bin of required) {
      try {
        const out = execSync(`which ${bin}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        available[bin] = out;
      } catch {
        missingRequired.push(bin);
      }
    }

    for (const bin of optional) {
      try {
        const out = execSync(`which ${bin}`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
        available[bin] = out;
      } catch {
        // optional
      }
    }

    if (missingRequired.length > 0) {
      return {
        category: "Dependencies",
        name: "System Binaries",
        status: "fail",
        message: `Missing required system dependencies: ${missingRequired.join(", ")}`,
        fixHint: `Install ${missingRequired.join(", ")} and ensure they are on your system PATH.`,
        autoFixable: false,
        details: { available, missingRequired },
      };
    }

    const hasDocker = Boolean(available.docker);
    return {
      category: "Dependencies",
      name: "System Binaries",
      status: "ok",
      message: `All core binaries present (git, node, npm). Docker sandbox: ${hasDocker ? "available" : "not detected (fallback to local)"}.`,
      details: { available, hasDocker },
    };
  },
};
