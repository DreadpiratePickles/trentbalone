import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import dotenv from "dotenv";
import {
  TrentConfigSchema,
  TrentSecretsSchema,
  type TrentConfig,
  type TrentSecrets,
} from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";

export class ConfigManager {
  private baseDir: string;
  private profile: string;
  private configCache: TrentConfig | null = null;
  private secretsCache: Record<string, string> | null = null;

  constructor(options?: { baseDir?: string; profile?: string }) {
    this.baseDir =
      options?.baseDir ||
      process.env.TRENT_HOME ||
      path.join(os.homedir(), ".trent");
    this.profile = options?.profile || process.env.TRENT_PROFILE || "default";
  }

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
    if (this.profile === "default") {
      return this.baseDir;
    }
    return path.join(this.baseDir, "profiles", this.profile);
  }

  public getConfigPath(): string {
    return path.join(this.getProfileDir(), "config.yaml");
  }

  public getSecretsPath(): string {
    return path.join(this.getProfileDir(), ".env");
  }

  public getSessionsDir(): string {
    return path.join(this.baseDir, "sessions");
  }

  public getSkillsDir(): string {
    return path.join(this.baseDir, "skills");
  }

  public getAgentsDir(): string {
    return path.join(this.baseDir, "agents");
  }

  public getPersonalitiesDir(): string {
    return path.join(this.baseDir, "personalities");
  }

  public ensureDirs(): void {
    const dirs = [
      this.baseDir,
      this.getProfileDir(),
      this.getSessionsDir(),
      this.getSkillsDir(),
      this.getAgentsDir(),
      this.getPersonalitiesDir(),
      path.join(this.baseDir, "logs"),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  public exists(): boolean {
    return (
      fs.existsSync(this.getConfigPath()) || fs.existsSync(this.getSecretsPath())
    );
  }

  public loadConfig(): TrentConfig {
    if (this.configCache) {
      return this.configCache;
    }

    const configPath = this.getConfigPath();
    if (!fs.existsSync(configPath)) {
      this.configCache = { ...DEFAULT_CONFIG, profile: this.profile };
      return this.configCache;
    }

    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = parseYaml(raw);
      const validated = TrentConfigSchema.parse(parsed || {});
      this.configCache = validated;
      return validated;
    } catch (err: any) {
      throw new Error(`Failed to parse config at ${configPath}: ${err.message}`);
    }
  }

  public saveConfig(config: TrentConfig): void {
    this.ensureDirs();
    const validated = TrentConfigSchema.parse(config);
    const yamlStr = stringifyYaml(validated);
    fs.writeFileSync(this.getConfigPath(), yamlStr, "utf8");
    this.configCache = validated;
  }

  public updateConfig(partial: Partial<TrentConfig>): void {
    const current = this.loadConfig();
    this.saveConfig({ ...current, ...partial });
  }

  public loadSecrets(): TrentSecrets {
    if (this.secretsCache) {
      return this.secretsCache;
    }

    const secretsPath = this.getSecretsPath();
    if (!fs.existsSync(secretsPath)) {
      this.secretsCache = {};
      return {};
    }

    const content = fs.readFileSync(secretsPath, "utf8");
    const parsed = dotenv.parse(content);
    const validated = TrentSecretsSchema.parse(parsed);
    this.secretsCache = validated;
    return validated;
  }

  public saveSecrets(secrets: Partial<TrentSecrets>): void {
    this.ensureDirs();
    const current = this.loadSecrets();
    const merged = { ...current, ...secrets };

    // Remove undefined values
    for (const key of Object.keys(merged) as Array<keyof TrentSecrets>) {
      if (merged[key] === undefined) {
        delete merged[key];
      }
    }

    const validated = TrentSecretsSchema.parse(merged);

    const envLines = Object.entries(validated)
      .filter(([_, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    fs.writeFileSync(this.getSecretsPath(), envLines + (envLines ? "\n" : ""), {
      encoding: "utf8",
      mode: 0o600, // secure read/write for owner only
    });

    this.secretsCache = validated;
  }

  public get(key: string): unknown {
    // Check if key is a secret first
    const secretKeys = Object.keys(TrentSecretsSchema.shape);
    if (secretKeys.includes(key) || key.endsWith("_KEY") || key.endsWith("_TOKEN") || key.endsWith("_SECRET")) {
      const secrets = this.loadSecrets();
      return (secrets as any)[key];
    }

    // Traverse config object by dot notation
    const config = this.loadConfig();
    const parts = key.split(".");
    let current: any = config;

    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }

    return current;
  }

  public set(key: string, value: unknown): void {
    const secretKeys = Object.keys(TrentSecretsSchema.shape);
    const isSecret =
      secretKeys.includes(key) ||
      key.endsWith("_KEY") ||
      key.endsWith("_TOKEN") ||
      key.endsWith("_SECRET") ||
      key.startsWith("secrets.");

    if (isSecret) {
      const secretKey = key.replace(/^secrets\./, "");
      this.saveSecrets({ [secretKey]: String(value) });
      return;
    }

    const config = this.loadConfig();
    const parts = key.split(".");
    let current: any = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== "object" || current[part] === null) {
        current[part] = {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];

    // Attempt type parsing for strings
    let parsedValue = value;
    if (typeof value === "string") {
      if (value === "true") parsedValue = true;
      else if (value === "false") parsedValue = false;
      else if (!isNaN(Number(value)) && value.trim() !== "") parsedValue = Number(value);
      else if (value.startsWith("[") && value.endsWith("]")) {
        try {
          parsedValue = JSON.parse(value);
        } catch {
          parsedValue = value;
        }
      }
    }

    current[lastPart] = parsedValue;
    this.saveConfig(config);
  }

  public delete(key: string): void {
    const secretKeys = Object.keys(TrentSecretsSchema.shape);
    const isSecret =
      secretKeys.includes(key) ||
      key.endsWith("_KEY") ||
      key.endsWith("_TOKEN") ||
      key.endsWith("_SECRET") ||
      key.startsWith("secrets.");

    if (isSecret) {
      const secretKey = key.replace(/^secrets\./, "");
      const secrets = this.loadSecrets();
      delete (secrets as any)[secretKey];
      this.saveSecrets(secrets);
      return;
    }

    const config = this.loadConfig();
    const parts = key.split(".");
    let current: any = config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) return;
      current = current[part];
    }

    delete current[parts[parts.length - 1]];
    this.saveConfig(config);
  }

  public listProfiles(): string[] {
    const profiles = ["default"];
    const profilesDir = path.join(this.baseDir, "profiles");
    if (fs.existsSync(profilesDir)) {
      const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          profiles.push(entry.name);
        }
      }
    }
    return profiles;
  }
}
