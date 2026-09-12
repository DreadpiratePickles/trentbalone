import fs from "node:fs";
import { type CheckResult, type DoctorCheck, type DoctorContext } from "../types.js";

export const checkCredentials: DoctorCheck = {
  id: "check_credentials",
  name: "API Credentials",
  category: "Credentials",
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const secretsPath = ctx.configManager.getSecretsPath();
    if (!fs.existsSync(secretsPath)) {
      return {
        category: "Credentials",
        name: "API Credentials",
        status: "warn",
        message: "No ~/.trent/.env secrets file found.",
        fix_hint: "Run `trent setup` or set API keys with `trent config set <KEY> <VALUE>`.",
        auto_fixable: false,
      };
    }

    try {
      const secrets = ctx.configManager.loadSecrets();
      const config = ctx.configManager.loadConfig();

      const providerKeyMap: Record<string, string> = {
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        google: "GOOGLE_API_KEY",
        mistral: "MISTRAL_API_KEY",
        openrouter: "OPENROUTER_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
      };

      const requiredKey = providerKeyMap[config.provider];
      const hasActiveKey = requiredKey ? Boolean((secrets as any)[requiredKey]) : false;

      const configuredProviders = Object.entries(providerKeyMap)
        .filter(([_, key]) => Boolean((secrets as any)[key]))
        .map(([provider]) => provider);

      if (!hasActiveKey) {
        return {
          category: "Credentials",
          name: "API Credentials",
          status: "error",
          message: `Active provider "${config.provider}" requires ${requiredKey}, which is missing or empty.`,
          fix_hint: `Run \`trent config set ${requiredKey} <your-api-key>\`.`,
          auto_fixable: false,
          details: { activeProvider: config.provider, configuredProviders },
        };
      }

      return {
        category: "Credentials",
        name: "API Credentials",
        status: "ok",
        message: `${configuredProviders.length} provider key(s) detected (${configuredProviders.join(", ")}), active provider "${config.provider}" is configured.`,
        details: { activeProvider: config.provider, configuredProviders },
      };
    } catch (err: any) {
      return {
        category: "Credentials",
        name: "API Credentials",
        status: "error",
        message: `Failed to read credentials: ${err.message}`,
        fix_hint: "Check ~/.trent/.env syntax and permissions.",
        auto_fixable: false,
      };
    }
  },
};
