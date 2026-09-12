import { ConfigManager } from "../config/ConfigManager.js";
import { BLANK_SLATE_CONFIG } from "../config/defaults.js";
import type { SetupOptions, SetupResult } from "./types.js";

export class BlankSlate {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public async execute(options?: Partial<SetupOptions>): Promise<SetupResult> {
    this.configManager.ensureDirs();

    const provider = options?.provider || "openai";
    const model = options?.model || "gpt-5.6-terra";

    const config = {
      ...BLANK_SLATE_CONFIG,
      provider,
      model,
      toolsets: ["file_ops", "terminal"] as any,
      disabled_toolsets: [
        "web",
        "browser",
        "code",
        "vision",
        "memory",
        "delegation",
        "cron",
        "skills",
        "plugins",
        "mcp",
      ] as any,
      fleet: {
        installed_agents: ["ceo"],
        active_agents: ["ceo"],
        default_agent: "ceo",
      },
    };

    this.configManager.saveConfig(config);

    const secretsConfigured: string[] = [];
    if (options?.apiKey) {
      const keyName =
        provider === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : provider === "google"
          ? "GOOGLE_API_KEY"
          : provider === "mistral"
          ? "MISTRAL_API_KEY"
          : provider === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "OPENAI_API_KEY";

      this.configManager.saveSecrets({ [keyName]: options.apiKey });
      secretsConfigured.push(keyName);
    }

    return {
      mode: "blank-slate",
      success: true,
      message: `Blank Slate baseline configured. Minimal agent only (provider: ${provider}, model: ${model}, file_ops, terminal). All 10 extended toolsets explicitly disabled.`,
      config,
      secretsConfigured,
    };
  }
}
