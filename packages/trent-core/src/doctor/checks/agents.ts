import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkAgents: DoctorCheck = {
  id: "check_agents",
  name: "Fleet Agents",
  category: "Agents",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    try {
      const config = ctx.configManager.loadConfig();
      const installed = config.fleet?.installed_agents || [];
      const active = config.fleet?.active_agents || [];

      if (installed.length === 0) {
        return {
          category: "Agents",
          name: "Fleet Agents",
          status: "warn",
          message: "No agents installed in fleet.",
          fix_hint: "Run `trent fleet install ceo` or `trent fleet install --pack engineering`.",
          auto_fixable: true,
        };
      }

      return {
        category: "Agents",
        name: "Fleet Agents",
        status: "ok",
        message: `${installed.length} installed agent(s) loaded (${active.length} active). Catalog contains 164 available specialists.`,
        details: { installed, active, defaultAgent: config.fleet?.default_agent },
      };
    } catch (err: any) {
      return {
        category: "Agents",
        name: "Fleet Agents",
        status: "error",
        message: `Agent validation failed: ${err.message}`,
        fix_hint: "Check fleet settings in ~/.trent/config.yaml.",
        auto_fixable: false,
      };
    }
  },
};
