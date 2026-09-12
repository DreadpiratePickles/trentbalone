import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { ConfigManager } from "./ConfigManager.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { CONFIG_SCHEMA_VERSION } from "./schema.js";

const ENV_KEYS_TO_CLEAN = [
  "TRENT_HOME",
  "TRENT_PROFILE",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "TRENT_TEST_ONLY_KEY",
];

describe("ConfigManager", () => {
  let tempDir: string;
  let manager: ConfigManager;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS_TO_CLEAN) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-test-config-"));
    // Never let a test reach the real ~/.trent.
    process.env.TRENT_HOME = tempDir;
    manager = new ConfigManager({ baseDir: tempDir });
  });

  afterEach(() => {
    for (const k of ENV_KEYS_TO_CLEAN) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("preserved public API", () => {
    it("initializes directories on ensureDirs", () => {
      manager.ensureDirs();
      expect(fs.existsSync(manager.getBaseDir())).toBe(true);
      expect(fs.existsSync(manager.getSessionsDir())).toBe(true);
      expect(fs.existsSync(manager.getSkillsDir())).toBe(true);
      expect(fs.existsSync(manager.getAgentsDir())).toBe(true);
      expect(fs.existsSync(manager.getPersonalitiesDir())).toBe(true);
    });

    it("returns default config when config.yaml is absent", () => {
      const config = manager.loadConfig();
      expect(config.provider).toBe(DEFAULT_CONFIG.provider);
      expect(config.model).toBe(DEFAULT_CONFIG.model);
    });

    it("saves and reloads a config through a fresh manager", () => {
      const config = manager.loadConfig();
      config.model = "claude-sonnet-5";
      manager.saveConfig(config);

      const fresh = new ConfigManager({ baseDir: tempDir });
      expect(fresh.loadConfig().model).toBe("claude-sonnet-5");
    });

    it("sets and gets values using dot notation", () => {
      manager.set("budget.daily_cap", 5000);
      expect(manager.get("budget.daily_cap")).toBe(5000);
    });

    it("deletes config and secret keys", () => {
      manager.set("OPENAI_API_KEY", "sk-delete-me");
      expect(manager.get("OPENAI_API_KEY")).toBe("sk-delete-me");
      manager.delete("OPENAI_API_KEY");
      expect(manager.get("OPENAI_API_KEY")).toBeUndefined();
    });

    it("lists profiles", () => {
      const dev = new ConfigManager({ baseDir: tempDir, profile: "dev" });
      dev.set("model", "claude-haiku-4.5");
      expect(manager.listProfiles()).toContain("default");
      expect(manager.listProfiles()).toContain("dev");
    });
  });

  // Defect 1 (most important): secrets never reached process.env, so any consumer
  // that freezes a registry at module load silently fell back to defaults.
  describe("loadSecrets populates process.env", () => {
    it("exports every parsed key into process.env and returns the map", () => {
      manager.ensureDirs();
      fs.writeFileSync(
        manager.getSecretsPath(),
        "GEMINI_API_KEY=gm-test-value\nTRENT_TEST_ONLY_KEY=abc123\n",
        "utf8",
      );

      expect(process.env.GEMINI_API_KEY).toBeUndefined();

      const secrets = manager.loadSecrets();

      expect(process.env.GEMINI_API_KEY).toBe("gm-test-value");
      expect(process.env.TRENT_TEST_ONLY_KEY).toBe("abc123");
      expect(secrets.GEMINI_API_KEY).toBe("gm-test-value");
      expect(secrets.TRENT_TEST_ONLY_KEY).toBe("abc123");
    });

    it("does not clobber a value already present in the real environment", () => {
      process.env.GEMINI_API_KEY = "from-real-environment";
      manager.ensureDirs();
      fs.writeFileSync(manager.getSecretsPath(), "GEMINI_API_KEY=from-file\n", "utf8");

      manager.loadSecrets();
      expect(process.env.GEMINI_API_KEY).toBe("from-real-environment");

      manager.loadSecrets({ override: true, force: true });
      expect(process.env.GEMINI_API_KEY).toBe("from-file");
    });

    it("exports secrets to process.env on save as well", () => {
      manager.saveSecrets({ TRENT_TEST_ONLY_KEY: "saved-value" });
      expect(process.env.TRENT_TEST_ONLY_KEY).toBe("saved-value");
    });
  });

  // Defect 2: bare writeFileSync corrupts config.yaml on a mid-write crash.
  describe("atomic writes", () => {
    it("leaves no .tmp file behind and writes complete content", () => {
      manager.saveConfig({ ...manager.loadConfig(), model: "atomic-model" });

      const dir = manager.getProfileDir();
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(leftovers).toEqual([]);

      const raw = fs.readFileSync(manager.getConfigPath(), "utf8");
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).toContain("atomic-model");
    });

    it("never leaves a zero-byte config when the write fails mid-flight", () => {
      manager.saveConfig({ ...manager.loadConfig(), model: "good-model" });
      const before = fs.readFileSync(manager.getConfigPath(), "utf8");
      expect(before).toContain("good-model");

      const failing = new ConfigManager({
        baseDir: tempDir,
        io: {
          writeFileSync: () => {
            throw new Error("simulated disk failure mid-write");
          },
        },
      });

      expect(() => failing.saveConfig({ ...failing.loadConfig(), model: "bad-model" })).toThrow();

      const after = fs.readFileSync(manager.getConfigPath(), "utf8");
      expect(after).toBe(before);
      expect(after.length).toBeGreaterThan(0);
      const leftovers = fs
        .readdirSync(manager.getProfileDir())
        .filter((f) => f.includes(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });

  // Defect 3: mode 0600 applied only at create time.
  describe("secrets file permissions", () => {
    it("chmods .env to 0600 on every write, not just on create", () => {
      manager.ensureDirs();
      const secretsPath = manager.getSecretsPath();
      fs.writeFileSync(secretsPath, "OPENAI_API_KEY=pre-existing\n", { mode: 0o644 });
      fs.chmodSync(secretsPath, 0o644);
      expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o644);

      manager.saveSecrets({ OPENAI_API_KEY: "sk-rewritten" });

      expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
      expect(manager.loadSecrets({ force: true }).OPENAI_API_KEY).toBe("sk-rewritten");
    });
  });

  // Defect 4: no schema version, so ~/.trent could never be migrated.
  describe("schema version and migrate()", () => {
    it("writes an integer version key", () => {
      manager.saveConfig(manager.loadConfig());
      const raw = fs.readFileSync(manager.getConfigPath(), "utf8");
      expect(raw).toContain(`version: ${CONFIG_SCHEMA_VERSION}`);
      expect(Number.isInteger(manager.loadConfig().version)).toBe(true);
    });

    it("upgrades a v1 config, converting float dollars to integer cents", () => {
      manager.ensureDirs();
      fs.writeFileSync(
        manager.getConfigPath(),
        stringifyYaml({
          version: "1.0.0",
          provider: "openai",
          model: "gpt-5.6-terra",
          budget: { daily_cap: 10.0, per_run_cap: 1.0, currency: "USD" },
        }),
        "utf8",
      );

      const result = manager.migrate();
      expect(result.migrated).toBe(true);
      expect(result.from).toBe(1);
      expect(result.to).toBe(CONFIG_SCHEMA_VERSION);

      const loaded = new ConfigManager({ baseDir: tempDir }).loadConfig();
      expect(loaded.version).toBe(CONFIG_SCHEMA_VERSION);
      expect(loaded.budget.daily_cap).toBe(1000);
      expect(loaded.budget.per_run_cap).toBe(100);
    });

    it("is a no-op on a current-version config", () => {
      manager.saveConfig({ ...manager.loadConfig(), model: "already-current" });
      const before = fs.readFileSync(manager.getConfigPath(), "utf8");

      const result = manager.migrate();
      expect(result.migrated).toBe(false);
      expect(result.from).toBe(CONFIG_SCHEMA_VERSION);
      expect(result.to).toBe(CONFIG_SCHEMA_VERSION);
      expect(fs.readFileSync(manager.getConfigPath(), "utf8")).toBe(before);
    });
  });

  // Defect 5: endsWith("_KEY") misroutes ordinary config keys into .env.
  describe("secret routing", () => {
    it("routes allowlisted and pattern-matching env-shaped names to .env", () => {
      manager.set("OPENAI_API_KEY", "sk-allowlisted");
      manager.set("SOME_SERVICE_PASSWORD", "pw-pattern");

      const envRaw = fs.readFileSync(manager.getSecretsPath(), "utf8");
      expect(envRaw).toContain("OPENAI_API_KEY=");
      expect(envRaw).toContain("SOME_SERVICE_PASSWORD=");
      expect(fs.existsSync(manager.getConfigPath())).toBe(false);
    });

    it("does NOT treat a non-secret config key such as public_key_id as a secret", () => {
      manager.set("public_key_id", "pk-visible-identifier");

      expect(fs.existsSync(manager.getSecretsPath())).toBe(false);
      const configRaw = fs.readFileSync(manager.getConfigPath(), "utf8");
      expect(configRaw).toContain("public_key_id");
      expect(manager.get("public_key_id")).toBe("pk-visible-identifier");
    });

    it("does not treat a lowercase dotted config path ending in _key as a secret", () => {
      manager.set("signing_public_key", "not-a-secret");
      expect(fs.existsSync(manager.getSecretsPath())).toBe(false);
      expect(manager.get("signing_public_key")).toBe("not-a-secret");
    });
  });

  // Defect 6: per-profile paths pointed at the base dir, so profiles shared state.
  describe("profile isolation", () => {
    it("puts sessions and every other per-profile path under the profile dir", () => {
      const dev = new ConfigManager({ baseDir: tempDir, profile: "dev" });
      expect(dev.getSessionsDir().startsWith(dev.getProfileDir())).toBe(true);
      expect(dev.getSkillsDir().startsWith(dev.getProfileDir())).toBe(true);
      expect(dev.getAgentsDir().startsWith(dev.getProfileDir())).toBe(true);
      expect(dev.getPersonalitiesDir().startsWith(dev.getProfileDir())).toBe(true);
      expect(dev.getLogsDir().startsWith(dev.getProfileDir())).toBe(true);
    });

    it("keeps two profiles from sharing sessions", () => {
      const a = new ConfigManager({ baseDir: tempDir, profile: "alpha" });
      const b = new ConfigManager({ baseDir: tempDir, profile: "beta" });
      a.ensureDirs();
      b.ensureDirs();

      expect(a.getSessionsDir()).not.toBe(b.getSessionsDir());
      fs.writeFileSync(path.join(a.getSessionsDir(), "s1.json"), "{}", "utf8");
      expect(fs.readdirSync(b.getSessionsDir())).toEqual([]);
    });

    it("keeps two profiles from sharing secrets", () => {
      const a = new ConfigManager({ baseDir: tempDir, profile: "alpha" });
      const b = new ConfigManager({ baseDir: tempDir, profile: "beta" });
      a.saveSecrets({ OPENAI_API_KEY: "sk-alpha" });
      expect(b.loadSecrets({ force: true }).OPENAI_API_KEY).toBeUndefined();
    });
  });

  // Requirement 7: zod validation on load, TrentError-shaped failure.
  describe("validation", () => {
    it("throws a TrentError-shaped failure for an invalid config", () => {
      manager.ensureDirs();
      fs.writeFileSync(
        manager.getConfigPath(),
        stringifyYaml({ version: CONFIG_SCHEMA_VERSION, provider: "not-a-provider" }),
        "utf8",
      );

      let caught: unknown;
      try {
        manager.loadConfig();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const e = caught as Error & { code?: number; operation?: string; target?: string };
      expect(e.code).toBe(3);
      expect(e.operation).toBe("config.load");
      expect(e.target).toBe(manager.getConfigPath());
      expect(e.message).toContain("provider");
    });

    it("throws a TrentError-shaped failure for unparseable YAML", () => {
      manager.ensureDirs();
      fs.writeFileSync(manager.getConfigPath(), "provider: [unclosed\n", "utf8");
      expect(() => manager.loadConfig()).toThrow(/config\.load/);
    });
  });

  // Requirement 8: money is integer cents.
  describe("money defaults", () => {
    it("defaults the daily cap to 1000 integer cents", () => {
      const config = manager.loadConfig();
      expect(config.budget.daily_cap).toBe(1000);
      expect(Number.isInteger(config.budget.daily_cap)).toBe(true);
      expect(config.budget.currency).toBe("USD");
    });

    it("rejects a fractional cent value", () => {
      expect(() => manager.set("budget.daily_cap", 10.5)).toThrow();
    });
  });
});
