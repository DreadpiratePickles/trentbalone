import { ConfigManager } from "../config/ConfigManager.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { SetupOptions, SetupResult } from "./types.js";

export class FullSetup {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public async execute(options?: Partial<SetupOptions>): Promise<SetupResult> {
    this.configManager.ensureDirs();

    const provider = options?.provider || "openai";
    const model = options?.model || "gpt-5.6-terra";
    const toolsets = options?.toolsets || [
      "file_ops",
      "terminal",
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
    ];
    const agents = options?.agents || ["ceo", "eng-ai-engineer", "support-responder", "growth-marketer"];
    const dailyBudget = options?.dailyBudget ?? 10.0;

    const config = {
      ...DEFAULT_CONFIG,
      provider,
      model,
      toolsets: toolsets as any,
      disabled_toolsets: [],
      fleet: {
        installed_agents: agents,
        active_agents: [agents[0] || "ceo"],
        default_agent: agents[0] || "ceo",
      },
      budget: {
        daily_cap: dailyBudget,
        currency: "USD",
        per_run_cap: 1.0,
        alert_thresholds: [50, 80, 100],
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
      mode: "full",
      success: true,
      message: `Full setup complete! Provider: ${provider}, Model: ${model}, Toolsets: ${toolsets.length}, Agents: ${agents.length}, Daily Budget: $${dailyBudget.toFixed(2)}.`,
      config,
      secretsConfigured,
    };
  }
}
