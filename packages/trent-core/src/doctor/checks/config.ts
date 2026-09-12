import fs from "node:fs";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkConfig: DoctorCheck = {
  id: "check_config",
  name: "Config Validity",
  category: "Config",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const configPath = ctx.configManager.getConfigPath();
    if (!fs.existsSync(configPath)) {
      return {
        category: "Config",
        name: "Config Validity",
        status: "warn",
        message: `Config file not found at ${configPath}; running with defaults.`,
        fixHint: "Run `trent setup` to generate an initial configuration.",
        autoFixable: true,
      };
    }

    try {
      const config = ctx.configManager.loadConfig();
      const missingFields: string[] = [];

      if (!config.provider) missingFields.push("provider");
      if (!config.model) missingFields.push("model");
      if (!config.toolsets) missingFields.push("toolsets");
      if (!config.budget) missingFields.push("budget");

      if (missingFields.length > 0) {
        return {
          category: "Config",
          name: "Config Validity",
          status: "warn",
          message: `Config has missing required fields: ${missingFields.join(", ")}`,
          fixHint: "Run `trent doctor --fix` to populate missing fields with defaults.",
          autoFixable: true,
        };
      }

      const profiles = ctx.configManager.listProfiles();
      return {
        category: "Config",
        name: "Config Validity",
        status: "ok",
        message: `Valid configuration (${profiles.length} profile${profiles.length === 1 ? "" : "s"} loaded)`,
        details: { provider: config.provider, model: config.model, profile: config.profile },
      };
    } catch (err: any) {
      return {
        category: "Config",
        name: "Config Validity",
        status: "fail",
        message: `Configuration syntax error: ${err.message}`,
        fixHint: "Inspect ~/.trent/config.yaml or reset with `trent setup`.",
        autoFixable: false,
      };
    }
  },
};
