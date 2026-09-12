import fs from "node:fs";
import path from "node:path";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkSkills: DoctorCheck = {
  id: "check_skills",
  name: "Skills Hub",
  category: "Skills",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const skillsDir = ctx.configManager.getSkillsDir();
    if (!fs.existsSync(skillsDir)) {
      return {
        category: "Skills",
        name: "Skills Hub",
        status: "ok",
        message: "Skills directory ready (0 custom skills installed).",
        details: { count: 0 },
      };
    }

    try {
      const entries = fs.readdirSync(skillsDir);
      let orphanSymlinks = 0;
      let validSkills = 0;

      for (const entry of entries) {
        const fullPath = path.join(skillsDir, entry);
        try {
          const stat = fs.lstatSync(fullPath);
          if (stat.isSymbolicLink()) {
            if (!fs.existsSync(fullPath)) {
              orphanSymlinks++;
            } else {
              validSkills++;
            }
          } else {
            validSkills++;
          }
        } catch {
          orphanSymlinks++;
        }
      }

      if (orphanSymlinks > 0) {
        return {
          category: "Skills",
          name: "Skills Hub",
          status: "warn",
          message: `Found ${orphanSymlinks} broken/orphan skill symlink(s).`,
          fix_hint: "Run `trent doctor --fix` to remove broken symlinks.",
          auto_fixable: true,
          details: { validSkills, orphanSymlinks },
        };
      }

      return {
        category: "Skills",
        name: "Skills Hub",
        status: "ok",
        message: `${validSkills} skill(s) synced and healthy.`,
        details: { validSkills },
      };
    } catch (err: any) {
      return {
        category: "Skills",
        name: "Skills Hub",
        status: "error",
        message: `Skills verification error: ${err.message}`,
        fix_hint: "Inspect ~/.trent/skills permissions and contents.",
        auto_fixable: false,
      };
    }
  },
};
