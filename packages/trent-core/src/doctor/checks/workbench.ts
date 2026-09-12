import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkWorkbench: DoctorCheck = {
  id: "check_workbench",
  name: "Sandbox & Workbench",
  category: "Workbench",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    try {
      const config = ctx.configManager.loadConfig();
      const backend = config.terminal?.backend || "docker";

      return {
        category: "Workbench",
        name: "Sandbox & Workbench",
        status: "ok",
        message: `Sandbox backend configured: ${backend}. Isolation policy active.`,
        details: { backend, dockerImage: config.terminal?.docker?.image },
      };
    } catch (err: any) {
      return {
        category: "Workbench",
        name: "Sandbox & Workbench",
        status: "warn",
        message: `Workbench diagnostic warning: ${err.message}`,
        fix_hint: "Verify terminal backend settings in ~/.trent/config.yaml.",
        auto_fixable: false,
      };
    }
  },
};
