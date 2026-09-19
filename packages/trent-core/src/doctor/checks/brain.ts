/**
 * [C2] Is the brain there, and is it versioned?
 *
 * The line exists because the answer is not binary. A brain without git still works — the files
 * are the truth and the lock is what keeps concurrent writers honest — so a missing git is a
 * WARNING, never a failure: what is lost is the audit trail and byte-exact rollback, not the
 * memory. A brain switched off in config, or one that has not been created because nothing has
 * run yet, is a skip that says which of the two it is.
 *
 * Nothing here creates the brain, and nothing here reads a note body. The doctor is a report.
 */
import { createBrain } from "../../fleet-memory/brain.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

// Its own category: `DoctorRunner.test.ts` asserts one category per check, and "Memory" is
// already the recall embedder's line.
const CATEGORY = "Brain";
const NAME = "Brain Repository";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

interface BrainSettings {
  readonly enabled: boolean;
  readonly versioning: "auto" | "off";
}

function settingsOf(ctx: DoctorContext): BrainSettings {
  try {
    const raw = (ctx.configManager.loadConfig() as { brain?: Partial<BrainSettings> }).brain;
    return { enabled: raw?.enabled !== false, versioning: raw?.versioning === "off" ? "off" : "auto" };
  } catch {
    return { enabled: true, versioning: "auto" };
  }
}

export const checkBrain: DoctorCheck = {
  id: "check_brain",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const settings = settingsOf(ctx);
    if (!settings.enabled) {
      return result({
        status: "skip",
        message: "brain.enabled is false, so no brain repository is created and no brain block reaches a prompt.",
        fixHint: "Set brain.enabled to true in config.yaml to keep identity, standing decisions and episodic notes in <profile>/brain/.",
        details: { enabled: false },
      });
    }

    const profileDir = ctx.configManager.getProfileDir();
    const brain = createBrain({ profileDir, versioning: settings.versioning });
    const status = brain.status();
    const counts = {
      enabled: true,
      root: status.root,
      exists: status.exists,
      versioning: status.versioning,
      reason: status.versioningReason,
      system: status.counts.system,
      notes: status.counts.memory,
      decisions: status.counts.decisions,
      seats: status.counts.seats,
      head: status.head,
    };

    if (!status.exists) {
      return result({
        status: "skip",
        message: "The brain has not been created yet: it is written on the first run that assembles a prompt.",
        fixHint: "Run any objective (for example `trent run \"summarise this week\"`) and the brain is created, with the memory blocks migrated into brain/system/.",
        details: counts,
      });
    }

    if (status.versioning) {
      return result({
        status: "ok",
        message:
          `The brain is versioned: ${String(status.counts.decisions)} decision(s), ${String(status.counts.memory)} day(s) of notes and ` +
          `${String(status.counts.system)} always-loaded file(s) under ${status.root}, every write committed with the seat and the run that made it.`,
        details: counts,
      });
    }

    if (status.versioningReason === "disabled") {
      return result({
        status: "skip",
        message: `brain.versioning is off, so the brain is plain files under ${status.root}: no commit history, no rollback, and the files are still the truth.`,
        fixHint: "Set brain.versioning to auto in config.yaml to version every brain write with git.",
        details: counts,
      });
    }

    const gitMissing = status.versioningReason === "git-missing";
    return result({
      status: "warn",
      message:
        `The brain works, but versioning is off: ${gitMissing ? "git is not on PATH" : "the brain directory is not a git repository"}. ` +
        "The files are still the truth; what is missing is the commit history, the blame and the byte-exact rollback.",
      fixHint: gitMissing
        ? "Install git and re-run `trent doctor`; the next brain write initialises the repository."
        : "Delete nothing: the next brain write initialises the repository. If you removed <profile>/brain/.git deliberately, set brain.versioning to off to stop this line.",
      details: counts,
    });
  },
};
