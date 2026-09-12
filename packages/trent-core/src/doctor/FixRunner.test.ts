import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ConfigManager } from "../config/ConfigManager.js";
import { FixRunner } from "./FixRunner.js";
import { sqlitePathFor } from "./checks/database.js";

let tempDir: string;
let configManager: ConfigManager;
let fixer: FixRunner;

/** Hash every regular file under a directory: path, mode and content. */
function hashTree(dir: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      // SQLite side files appear and vanish with each connection; they are not state.
      if (/-(wal|shm)$/.test(entry.name)) continue;
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else if (entry.isSymbolicLink()) {
        hash.update(`L:${rel}:${fs.readlinkSync(full)}\n`);
      } else {
        const stat = fs.statSync(full);
        hash.update(`F:${rel}:${(stat.mode & 0o777).toString(8)}:`);
        hash.update(fs.readFileSync(full));
        hash.update("\n");
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fix-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  fixer = new FixRunner(configManager, { probeTimeoutMs: 150 });
  vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
  vi.stubEnv("REDIS_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("FixRunner", () => {
  it("creates the missing directories and a default config", async () => {
    const { actions } = await fixer.runFixes();
    expect(fs.existsSync(configManager.getConfigPath())).toBe(true);
    expect(fs.existsSync(configManager.getSessionsDir())).toBe(true);
    expect(actions.some((a) => a.action === "create_directories" && a.changed)).toBe(true);
    expect(actions.some((a) => a.action === "write_default_config" && a.changed)).toBe(true);
  }, 30000);

  it("removes an orphan symlink but leaves a live one alone", async () => {
    configManager.ensureDirs();
    const target = path.join(tempDir, "real-skill.md");
    fs.writeFileSync(target, "# skill");
    fs.symlinkSync(target, path.join(configManager.getSkillsDir(), "live.md"));
    fs.symlinkSync(path.join(tempDir, "gone.md"), path.join(configManager.getSkillsDir(), "orphan.md"));

    await fixer.runFixes();
    expect(fs.existsSync(path.join(configManager.getSkillsDir(), "live.md"))).toBe(true);
    expect(fs.lstatSync(path.join(configManager.getSkillsDir(), "orphan.md"), { throwIfNoEntry: false }))
      .toBeUndefined();
  }, 30000);

  it("quarantines a corrupt session file without deleting it", async () => {
    configManager.ensureDirs();
    fs.writeFileSync(path.join(configManager.getSessionsDir(), "bad.json"), "{broken");
    fs.writeFileSync(path.join(configManager.getSessionsDir(), "good.json"), '{"id":"s1"}');

    await fixer.runFixes();
    const quarantined = path.join(configManager.getSessionsDir(), ".quarantine", "bad.json");
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.readFileSync(quarantined, "utf8")).toBe("{broken");
    expect(fs.existsSync(path.join(configManager.getSessionsDir(), "good.json"))).toBe(true);
  }, 30000);

  it("chmods the secrets file to 0600 and never reads or rewrites its contents", async () => {
    configManager.ensureDirs();
    const secretsPath = configManager.getSecretsPath();
    fs.writeFileSync(secretsPath, "ANTHROPIC_API_KEY=sk-ant-placeh0ld\n", { mode: 0o644 });
    fs.chmodSync(secretsPath, 0o644);

    await fixer.runFixes();
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(secretsPath, "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-placeh0ld\n");
  }, 30000);

  it("enables WAL on an existing database", async () => {
    configManager.ensureDirs();
    const dbPath = sqlitePathFor(configManager);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = delete;");
    db.exec("CREATE TABLE t (id TEXT);");
    db.close();

    await fixer.runFixes();

    const reopened = new DatabaseSync(dbPath);
    const row = reopened.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
    reopened.close();
    expect(String(row.journal_mode).toLowerCase()).toBe("wal");
  }, 30000);

  it("never touches the secrets file contents and never deletes user data", async () => {
    configManager.ensureDirs();
    fs.writeFileSync(configManager.getSecretsPath(), "ANTHROPIC_API_KEY=sk-ant-placeh0ld\n");
    fs.writeFileSync(path.join(configManager.getSessionsDir(), "keep.json"), '{"id":"keep"}');

    const { actions } = await fixer.runFixes();
    expect(actions.every((a) => !/credential|secret_value|delete_session/.test(a.action))).toBe(true);
    expect(fs.existsSync(path.join(configManager.getSessionsDir(), "keep.json"))).toBe(true);
  }, 30000);

  it("is idempotent: a second run changes nothing on disk", async () => {
    configManager.ensureDirs();
    fs.writeFileSync(path.join(configManager.getSessionsDir(), "bad.json"), "{broken");
    fs.symlinkSync(path.join(tempDir, "gone.md"), path.join(configManager.getSkillsDir(), "orphan.md"));
    fs.writeFileSync(configManager.getSecretsPath(), "ANTHROPIC_API_KEY=sk-ant-placeh0ld\n", { mode: 0o644 });
    fs.chmodSync(configManager.getSecretsPath(), 0o644);
    const db = new DatabaseSync(sqlitePathFor(configManager));
    db.exec("PRAGMA journal_mode = delete;");
    db.exec("CREATE TABLE t (id TEXT);");
    db.close();

    await fixer.runFixes();
    const before = hashTree(tempDir);

    const second = await fixer.runFixes();
    const after = hashTree(tempDir);

    expect(after).toBe(before);
    expect(second.actions.filter((a) => a.changed)).toEqual([]);
  }, 60000);

  it("advertises no fix it cannot perform", async () => {
    const { actions } = await fixer.runFixes();
    expect(actions.some((a) => /prune/.test(a.action))).toBe(false);
  }, 30000);
});
