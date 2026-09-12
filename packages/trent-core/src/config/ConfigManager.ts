import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import dotenv from "dotenv";
import {
  TrentConfigSchema,
  TrentSecretsSchema,
  CONFIG_SCHEMA_VERSION,
  type TrentConfig,
  type TrentSecrets,
} from "./schema.js";
import { DEFAULT_CONFIG, cloneConfig } from "./defaults.js";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "./atomic-fs.js";
import { migrateConfigObject, type MigrationResult } from "./migrate.js";
import { isSecretKey, toSecretName } from "./secrets-policy.js";
import { configError } from "./errors.js";

const SECRETS_FILE_MODE = 0o600;
const CONFIG_FILE_MODE = 0o644;

export interface ConfigManagerOptions {
  baseDir?: string;
  profile?: string;
  /** Injectable filesystem, for tests that simulate a failing write. */
  io?: Partial<ConfigIO>;
}

export interface LoadSecretsOptions {
  /** Overwrite a value that is already present in process.env. Default false. */
  override?: boolean;
  /** Bypass the in-memory cache and re-read the file. Default false. */
  force?: boolean;
}

export class ConfigManager {
  private baseDir: string;
  private profile: string;
  private io: ConfigIO;
  private configCache: TrentConfig | null = null;
  private secretsCache: TrentSecrets | null = null;

  constructor(options?: ConfigManagerOptions) {
    this.baseDir =
      options?.baseDir || process.env.TRENT_HOME || path.join(os.homedir(), ".trent");
    this.profile = options?.profile || process.env.TRENT_PROFILE || "default";
    this.io = { ...NODE_IO, ...(options?.io ?? {}) };
  }

  // ---------------------------------------------------------------- paths

  public getBaseDir(): string {
    return this.baseDir;
  }

  public getProfile(): string {
    return this.profile;
  }

  public setProfile(profile: string): void {
    this.profile = profile;
    this.configCache = null;
    this.secretsCache = null;
  }

  public getProfileDir(): string {
    if (this.profile === "default") return this.baseDir;
    return path.join(this.baseDir, "profiles", this.profile);
  }

  public getConfigPath(): string {
    return path.join(this.getProfileDir(), "config.yaml");
  }

  public getSecretsPath(): string {
    return path.join(this.getProfileDir(), ".env");
  }

  // Every per-profile path hangs off the PROFILE dir. Previously these hung off the
  // base dir, so two profiles shared one sessions/skills/agents store.
  public getSessionsDir(): string {
    return path.join(this.getProfileDir(), "sessions");
  }

  public getSkillsDir(): string {
    return path.join(this.getProfileDir(), "skills");
  }

  public getAgentsDir(): string {
    return path.join(this.getProfileDir(), "agents");
  }

  public getPersonalitiesDir(): string {
    return path.join(this.getProfileDir(), "personalities");
  }

  public getLogsDir(): string {
    return path.join(this.getProfileDir(), "logs");
  }

  public ensureDirs(): void {
    const dirs = [
      this.baseDir,
      this.getProfileDir(),
      this.getSessionsDir(),
      this.getSkillsDir(),
      this.getAgentsDir(),
      this.getPersonalitiesDir(),
      this.getLogsDir(),
    ];
    for (const dir of dirs) {
      if (!this.io.existsSync(dir)) this.io.mkdirSync(dir, { recursive: true });
    }
  }

  public exists(): boolean {
    return (
      this.io.existsSync(this.getConfigPath()) || this.io.existsSync(this.getSecretsPath())
    );
  }

  // --------------------------------------------------------------- config

  public loadConfig(): TrentConfig {
    if (this.configCache) return this.configCache;

    const configPath = this.getConfigPath();
    if (!this.io.existsSync(configPath)) {
      this.configCache = { ...cloneConfig(DEFAULT_CONFIG), profile: this.profile };
      return this.configCache;
    }

    const validated = TrentConfigSchema.parse(this.readMigratedRaw(configPath).value);
    this.configCache = validated;
    return validated;
  }

  public saveConfig(config: TrentConfig): void {
    this.ensureDirs();
    const validated = this.validate(config, "config.save", this.getConfigPath());
    atomicWriteFileSync(
      this.io,
      this.getConfigPath(),
      stringifyYaml(validated),
      CONFIG_FILE_MODE,
    );
    this.configCache = validated;
  }

  public updateConfig(partial: Partial<TrentConfig>): void {
    this.saveConfig({ ...this.loadConfig(), ...partial });
  }

  /**
   * Upgrade `config.yaml` in place to the current schema version. A no-op that writes
   * nothing when the file is already current or absent.
   */
  public migrate(): MigrationResult {
    const configPath = this.getConfigPath();
    if (!this.io.existsSync(configPath)) {
      return { migrated: false, from: CONFIG_SCHEMA_VERSION, to: CONFIG_SCHEMA_VERSION, notes: [] };
    }

    const { value, result } = this.readMigratedRaw(configPath);
    if (!result.migrated) return result;

    const validated = this.validate(value, "config.migrate", configPath);
    atomicWriteFileSync(this.io, configPath, stringifyYaml(validated), CONFIG_FILE_MODE);
    this.configCache = validated;
    return result;
  }

  private readMigratedRaw(configPath: string): { value: unknown; result: MigrationResult } {
    let parsed: unknown;
    try {
      parsed = parseYaml(this.io.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw configError(
        "config.load",
        `unparseable YAML: ${err instanceof Error ? err.message : String(err)}`,
        configPath,
      );
    }
    const { value, result } = migrateConfigObject(parsed ?? {});
    // Validate eagerly so a bad file fails at load, not at first use.
    this.validate(value, "config.load", configPath);
    return { value, result };
  }

  private validate(input: unknown, operation: string, target: string): TrentConfig {
    const parsed = TrentConfigSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"} ${i.message}`)
        .join("; ");
      throw configError(operation, `invalid config: ${detail}`, target, {
        issueCount: parsed.error.issues.length,
      });
    }
    return parsed.data;
  }

  // -------------------------------------------------------------- secrets

  /**
   * Parse `<profile>/.env` AND export every key into `process.env`. The export is the
   * point: consumers that freeze a registry at module load see nothing otherwise.
   * A value already present in the real environment wins unless `override` is set.
   * Values are never logged.
   */
  public loadSecrets(options?: LoadSecretsOptions): TrentSecrets {
    const override = options?.override ?? false;

    if (this.secretsCache && !options?.force) {
      this.exportToEnv(this.secretsCache, override);
      return this.secretsCache;
    }

    const secretsPath = this.getSecretsPath();
    if (!this.io.existsSync(secretsPath)) {
      this.secretsCache = TrentSecretsSchema.parse({});
      return this.secretsCache;
    }

    const parsed = dotenv.parse(this.io.readFileSync(secretsPath, "utf8"));
    const result = TrentSecretsSchema.safeParse(parsed);
    if (!result.success) {
      // Report the offending key names only, never their values.
      throw configError(
        "secrets.load",
        `invalid secrets file for keys: ${result.error.issues
          .map((i) => i.path.join("."))
          .join(", ")}`,
        secretsPath,
      );
    }

    this.secretsCache = result.data;
    this.exportToEnv(result.data, override);
    return result.data;
  }

  public saveSecrets(secrets: Partial<TrentSecrets>): void {
    this.ensureDirs();
    const merged: Record<string, string> = { ...this.loadSecrets() } as Record<string, string>;
    for (const [key, value] of Object.entries(secrets)) {
      if (value === undefined || value === null || value === "") delete merged[key];
      else merged[key] = String(value);
    }

    const validated = TrentSecretsSchema.parse(merged);
    const body = Object.entries(validated)
      .filter(([, v]) => typeof v === "string" && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("\n");

    atomicWriteFileSync(
      this.io,
      this.getSecretsPath(),
      body + (body ? "\n" : ""),
      SECRETS_FILE_MODE,
    );

    this.secretsCache = validated;
    this.exportToEnv(validated, true);
  }

  private exportToEnv(secrets: TrentSecrets, override: boolean): void {
    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value !== "string" || value === "") continue;
      const existing = process.env[key];
      if (!override && existing !== undefined && existing !== "") continue;
      process.env[key] = value;
    }
  }

  // ------------------------------------------------------------ accessors

  public get(key: string): unknown {
    if (isSecretKey(key)) {
      return (this.loadSecrets() as Record<string, unknown>)[toSecretName(key)];
    }

    let current: unknown = this.loadConfig();
    for (const part of key.split(".")) {
      if (current === undefined || current === null) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  public set(key: string, value: unknown): void {
    if (isSecretKey(key)) {
      this.saveSecrets({ [toSecretName(key)]: String(value) });
      return;
    }

    const config = cloneConfig(this.loadConfig()) as unknown as Record<string, unknown>;
    const parts = key.split(".");
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      const next = current[part];
      if (typeof next !== "object" || next === null) current[part] = {};
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1] as string] = coerceScalar(value);
    this.saveConfig(config as unknown as TrentConfig);
  }

  public delete(key: string): void {
    if (isSecretKey(key)) {
      const name = toSecretName(key);
      const secrets = { ...this.loadSecrets() } as Record<string, string | undefined>;
      delete secrets[name];
      delete process.env[name];
      this.replaceSecrets(secrets);
      return;
    }

    const config = cloneConfig(this.loadConfig()) as unknown as Record<string, unknown>;
    const parts = key.split(".");
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = current[parts[i] as string];
      if (typeof next !== "object" || next === null) return;
      current = next as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1] as string];
    this.saveConfig(config as unknown as TrentConfig);
  }

  /** Write the secrets file to exactly this set, dropping anything not listed. */
  private replaceSecrets(secrets: Record<string, string | undefined>): void {
    this.secretsCache = TrentSecretsSchema.parse({});
    this.ensureDirs();
    const body = Object.entries(secrets)
      .filter(([, v]) => typeof v === "string" && v !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("\n");
    atomicWriteFileSync(
      this.io,
      this.getSecretsPath(),
      body + (body ? "\n" : ""),
      SECRETS_FILE_MODE,
    );
    this.secretsCache = TrentSecretsSchema.parse(
      Object.fromEntries(Object.entries(secrets).filter(([, v]) => typeof v === "string")),
    );
  }

  public listProfiles(): string[] {
    const profiles = ["default"];
    const profilesDir = path.join(this.baseDir, "profiles");
    if (this.io.existsSync(profilesDir)) {
      for (const entry of this.io.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) profiles.push(entry.name);
      }
    }
    return profiles;
  }
}

/** Best-effort scalar coercion for values arriving as CLI strings. */
function coerceScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
