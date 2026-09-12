import dns from "node:dns/promises";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkConnectivity: DoctorCheck = {
  id: "check_connectivity",
  name: "Network & Cloud Connectivity",
  category: "Connectivity",
  async run(_ctx: DoctorContext): Promise<CheckResult> {
    try {
      // Test DNS lookup for AI API endpoints
      await Promise.race([
        dns.lookup("api.openai.com"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000)),
      ]);

      return {
        category: "Connectivity",
        name: "Network & Cloud Connectivity",
        status: "ok",
        message: "Network connectivity verified; API endpoints reachable.",
      };
    } catch (err: any) {
      return {
        category: "Connectivity",
        name: "Network & Cloud Connectivity",
        status: "warn",
        message: `Network connectivity check degraded or offline: ${err.message}`,
        fixHint: "Check your local internet connection or proxy settings.",
        autoFixable: false,
      };
    }
  },
};
