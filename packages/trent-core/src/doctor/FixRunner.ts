import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigManager } from "../config/ConfigManager.js";
import { DoctorRunner, type DoctorRunnerOptions } from "./DoctorRunner.js";
import { sqlitePathFor } from "./checks/database.js";
import { egressRootFixHint, egressRootParseError, egressRootPath } from "./checks/egress-ca.js";
import type { DoctorReport } from "./types.js";

/**
 * Safe automatic remediation only.
 *
 * Two rules bound everything here: a fix never touches a credential's value, and a fix never deletes
 * user data. A corrupt session file is moved into `.quarantine/`, not removed; the secrets file has
 * its mode changed but is never read or rewritten. Every fix is also idempotent — it reports
 * `changed: false` and writes nothing when the desired state already holds — because `--fix` is
 * expected to be safe to run in a loop, and a fix that churns the disk cannot be verified.
 *
 * One fix does unlink a file: the egress root that OpenSSL refuses. It is not user data — the proxy
 * mints a replacement on the next interception, and while the bad one is on disk every interception
 * fails — but it is still a deletion, so it is announced through `options.announce` (stderr by
 * default) BEFORE the unlink, naming the file and the sandbox rebuild it forces.
 */

export const SECRETS_FILE_MODE = 0o600;
export const QUARANTINE_DIR = ".quarantine";

export interface FixAction {
  category: string;
  action: string;
  /** False when the desired state already held. This is what makes `--fix` verifiable. */
  changed: boolean;
  success: boolean;
  message: string;
}

export class FixRunner {
  private readonly configManager: ConfigManager;
  private readonly options: DoctorRunnerOptions;

  constructor(configManager?: ConfigManager, options: DoctorRunnerOptions = {}) {
    this.configManager = configManager ?? new ConfigManager();
    this.options = options;
  }

  public async runFixes(): Promise<{ actions: FixAction[]; newReport: DoctorReport }> {
    const actions: FixAction[] = [
      this.createDirectories(),
      this.writeDefaultConfig(),
      this.unlinkOrphanSymlinks(),
      this.quarantineCorruptSessions(),
      this.restrictSecretsFileMode(),
      this.enableWal(),
      this.removeUnreadableEgressRoot(),
    ];

    const newReport = await new DoctorRunner(this.configManager, this.options).runAll();
    return { actions, newReport };
  }

  private attempt(
    category: string,
    action: string,
    work: () => { changed: boolean; message: string },
  ): FixAction {
    try {
      const { changed, message } = work();
      return { category, action, changed, success: true, message };
    } catch (err) {
      return {
        category,
        action,
        changed: false,
        success: false,
        message: `${action} failed: ${(err as Error).message}`,
      };
    }
  }

  private createDirectories(): FixAction {
    return this.attempt("Config", "create_directories", () => {
      const dirs = [
        this.configManager.getProfileDir(),
        this.configManager.getSessionsDir(),
        this.configManager.getSkillsDir(),
        this.configManager.getAgentsDir(),
        this.configManager.getPersonalitiesDir(),
        this.configManager.getLogsDir(),
      ];
      const missing = dirs.filter((dir) => !fs.existsSync(dir));
      if (missing.length === 0) return { changed: false, message: "All directories already exist." };
      this.configManager.ensureDirs();
      return { changed: true, message: `Created ${missing.length} missing director(ies).` };
    });
  }

  private writeDefaultConfig(): FixAction {
    return this.attempt("Config", "write_default_config", () => {
      const configPath = this.configManager.getConfigPath();
      if (fs.existsSync(configPath)) return { changed: false, message: "Config already present." };
      this.configManager.saveConfig(this.configManager.loadConfig());
      return { changed: true, message: `Wrote a default config to ${configPath}.` };
    });
  }

  private unlinkOrphanSymlinks(): FixAction {
    return this.attempt("Skills", "unlink_orphan_symlinks", () => {
      const skillsDir = this.configManager.getSkillsDir();
      if (!fs.existsSync(skillsDir)) return { changed: false, message: "No skills directory." };

      const removed: string[] = [];
      for (const entry of fs.readdirSync(skillsDir)) {
        const full = path.join(skillsDir, entry);
        const stat = fs.lstatSync(full, { throwIfNoEntry: false });
        // Only a symlink whose target is gone. A real file is user data and is never touched.
        if (stat?.isSymbolicLink() && !fs.existsSync(full)) {
          fs.unlinkSync(full);
          removed.push(entry);
        }
      }
      return removed.length === 0
        ? { changed: false, message: "No orphan symlinks." }
        : { changed: true, message: `Unlinked ${removed.length} orphan symlink(s): ${removed.join(", ")}.` };
    });
  }

  private quarantineCorruptSessions(): FixAction {
    return this.attempt("Sessions", "quarantine_corrupt_sessions", () => {
      const sessionsDir = this.configManager.getSessionsDir();
      if (!fs.existsSync(sessionsDir)) return { changed: false, message: "No sessions directory." };

      const quarantineDir = path.join(sessionsDir, QUARANTINE_DIR);
      const moved: string[] = [];

      for (const entry of fs.readdirSync(sessionsDir)) {
        if (!entry.endsWith(".json")) continue;
        const full = path.join(sessionsDir, entry);
        if (!fs.statSync(full).isFile()) continue;
        try {
          JSON.parse(fs.readFileSync(full, "utf8"));
          continue;
        } catch {
          // Moved, never deleted: an unreadable session may still be recoverable by hand.
          fs.mkdirSync(quarantineDir, { recursive: true });
          fs.renameSync(full, path.join(quarantineDir, entry));
          moved.push(entry);
        }
      }

      return moved.length === 0
        ? { changed: false, message: "No corrupt session files." }
        : {
            changed: true,
            message: `Moved ${moved.length} unreadable session file(s) into ${QUARANTINE_DIR}/; nothing was deleted.`,
          };
    });
  }

  private restrictSecretsFileMode(): FixAction {
    return this.attempt("Credentials", "restrict_secrets_file_mode", () => {
      const secretsPath = this.configManager.getSecretsPath();
      if (!fs.existsSync(secretsPath)) return { changed: false, message: "No secrets file." };
      const mode = fs.statSync(secretsPath).mode & 0o777;
      if (mode === SECRETS_FILE_MODE) return { changed: false, message: "Secrets file is already 0600." };
      // The mode changes; the contents are never read, rewritten, or logged.
      fs.chmodSync(secretsPath, SECRETS_FILE_MODE);
      return { changed: true, message: `Set ${secretsPath} to mode 0600.` };
    });
  }

  private enableWal(): FixAction {
    return this.attempt("Database", "enable_wal", () => {
      const dbPath = sqlitePathFor(this.configManager);
      if (!fs.existsSync(dbPath)) return { changed: false, message: "No database file." };

      const db = new DatabaseSync(dbPath);
      try {
        const current = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
        if (String(current?.journal_mode ?? "").toLowerCase() === "wal") {
          return { changed: false, message: "Database is already in WAL mode." };
        }
        db.exec("PRAGMA journal_mode = wal;");
        return { changed: true, message: `Enabled WAL on ${dbPath}.` };
      } finally {
        db.close();
      }
    });
  }

  /** Says what it is about to delete, then deletes it. A root that parses is never touched. */
  private removeUnreadableEgressRoot(): FixAction {
    return this.attempt("Egress", "remove_unreadable_egress_root", () => {
      const caPath = egressRootPath(this.configManager);
      if (!fs.existsSync(caPath)) return { changed: false, message: "No egress root on this host." };
      const parseError = egressRootParseError(caPath);
      if (parseError === null) return { changed: false, message: `The egress root at ${caPath} parses; leaving it in place.` };

      this.announce(
        `doctor --fix: deleting ${caPath}, which OpenSSL refuses (${parseError}). ${egressRootFixHint(caPath)}`,
      );
      fs.rmSync(caPath);
      return {
        changed: true,
        message: `Deleted the unreadable egress root ${caPath}; the proxy mints a new one on the next interception, and any sandbox that trusted the old root needs \`trent sandbox build\`.`,
      };
    });
  }

  private announce(line: string): void {
    if (this.options.announce) this.options.announce(line);
    else process.stderr.write(`${line}\n`);
  }
}
