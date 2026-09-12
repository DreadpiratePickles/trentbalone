import fs from "node:fs";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { BUILTIN_PERSONALITIES, type Personality } from "./built-in.js";

export class PersonalityManager {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public list(): Personality[] {
    const list = Object.values(BUILTIN_PERSONALITIES);
    const customDir = this.configManager.getPersonalitiesDir();

    if (fs.existsSync(customDir)) {
      try {
        const files = fs.readdirSync(customDir);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const raw = JSON.parse(fs.readFileSync(path.join(customDir, file), "utf8"));
            list.push({
              name: raw.name || file.replace(".json", ""),
              description: raw.description || "Custom personality",
              systemPromptSuffix: raw.systemPromptSuffix || raw.suffix || "",
            });
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    return list;
  }

  public get(name: string): Personality | undefined {
    const norm = name.toLowerCase().trim();
    if (BUILTIN_PERSONALITIES[norm]) {
      return BUILTIN_PERSONALITIES[norm];
    }

    const customDir = this.configManager.getPersonalitiesDir();
    const customPath = path.join(customDir, `${norm}.json`);
    if (fs.existsSync(customPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(customPath, "utf8"));
        return {
          name: raw.name || norm,
          description: raw.description || "Custom personality",
          systemPromptSuffix: raw.systemPromptSuffix || raw.suffix || "",
        };
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  public setPersonality(name: string): Personality {
    const p = this.get(name);
    if (!p) {
      throw new Error(
        `Personality "${name}" not found. Available: ${this.list().map((x) => x.name).join(", ")}`
      );
    }

    const config = this.configManager.loadConfig();
    config.personality = p.name;
    this.configManager.saveConfig(config);

    return p;
  }

  public getActivePersonality(): Personality {
    const config = this.configManager.loadConfig();
    const active = config.personality || "default";
    return this.get(active) || BUILTIN_PERSONALITIES.default;
  }

  public applyToPrompt(basePrompt: string, personalityName?: string): string {
    const p = personalityName ? this.get(personalityName) : this.getActivePersonality();
    const suffix = p ? p.systemPromptSuffix : BUILTIN_PERSONALITIES.default.systemPromptSuffix;
    return `${basePrompt}\n${suffix}`;
  }
}
