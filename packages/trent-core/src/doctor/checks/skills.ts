import fs from "node:fs";
import path from "node:path";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

/**
 * Where the app reads a seat's GRANTED skills from: the launch directory, not the profile
 * (`apps/web/lib/agent-skill-instructions.ts`). A workspace without it runs every seat without
 * those instructions; the loader treats that as zero skills and this check is the one place
 * that says so.
 */
export const WORKSPACE_SKILLS_DIR = ".claude/skills";

interface WorkspaceSkills {
  dir: string;
  present: boolean;
  count: number;
}

function inspectWorkspaceSkills(): WorkspaceSkills {
  const dir = path.join(process.cwd(), WORKSPACE_SKILLS_DIR);
  try {
    const count = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
    return { dir, present: true, count };
  } catch {
    return { dir, present: false, count: 0 };
  }
}

/** The one note about the workspace, appended to whatever the profile's hub says. */
function withWorkspaceNote(result: CheckResult, workspaceSkills: WorkspaceSkills): CheckResult {
  const note = workspaceSkills.present
    ? `The workspace has ${workspaceSkills.count} skill(s) in ${WORKSPACE_SKILLS_DIR} for the seats to load.`
    : `The workspace has no ${WORKSPACE_SKILLS_DIR}, so the seats run without their granted skill instructions.`;
  return {
    ...result,
    message: `${result.message} ${note}`,
    details: { ...(result.details ?? {}), workspaceSkills },
  };
}

/** The profile's own skills hub (`<profile>/skills`), unchanged. */
const hub: DoctorCheck = {
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
          fixHint: "Run `trent doctor --fix` to remove broken symlinks.",
          autoFixable: true,
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
        status: "fail",
        message: `Skills verification error: ${err.message}`,
        fixHint: "Inspect ~/.trent/skills permissions and contents.",
        autoFixable: false,
      };
    }
  },
};

export const checkSkills: DoctorCheck = {
  ...hub,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    return withWorkspaceNote(await hub.run(ctx), inspectWorkspaceSkills());
  },
};
