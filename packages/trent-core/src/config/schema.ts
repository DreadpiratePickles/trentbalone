import { z } from "zod";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";

export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "deepseek",
  "groq",
  "ollama",
]);

export type Provider = z.infer<typeof ProviderSchema>;

export const ToolsetSchema = z.enum([
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
]);

export type Toolset = z.infer<typeof ToolsetSchema>;

export const TerminalBackendSchema = z.enum(["docker", "ssh", "e2b", "local"]);
export type TerminalBackendType = z.infer<typeof TerminalBackendSchema>;

/**
 * Money is INTEGER CENTS everywhere, never floating-point dollars — this matches the
 * rule the rest of the platform already follows. `daily_cap: 1000` is USD 10.00.
 * `alert_thresholds` stays a list of PERCENTAGES, not money.
 */
export const BudgetConfigSchema = z.object({
  daily_cap: z.number().int().positive().default(1000),
  currency: z.string().default("USD"),
  per_run_cap: z.number().int().positive().default(100),
  alert_thresholds: z.array(z.number()).default([50, 80, 100]),
});

export const TerminalConfigSchema = z.object({
  backend: TerminalBackendSchema.default("docker"),
  docker: z
    .object({
      image: z.string().default(SANDBOX_IMAGE),
      network: z.string().default("bridge"),
    })
    .default({}),
  ssh: z
    .object({
      host: z.string().optional(),
      port: z.number().default(22),
      user: z.string().optional(),
      key_path: z.string().optional(),
    })
    .default({}),
});

export const EgressConfigSchema = z.object({
  enabled: z.boolean().default(true),
  proxy_port: z.number().default(8089),
  auto_token: z.boolean().default(true),
  intercept_domains: z.array(z.string()).default(["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"]),
});

export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.enum(["tiny", "base", "small", "medium"]).default("base"),
  trigger_key: z.string().default("Ctrl+B"),
  tts_enabled: z.boolean().default(false),
});

export const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  platforms: z.array(z.string()).default([]),
  routes: z.record(z.string(), z.string()).default({}), // platform -> agentId
});

export const FleetConfigSchema = z.object({
  installed_agents: z.array(z.string()).default(["ceo", "eng-ai-engineer", "support-responder"]),
  active_agents: z.array(z.string()).default(["ceo"]),
  default_agent: z.string().default("ceo"),
});

/**
 * Integer on-disk schema version for `config.yaml`. Bump this and add a step to
 * `migrate.ts` whenever the stored shape changes.
 *   1 -> pre-versioned layout, budget in float dollars.
 *   2 -> integer `version` key, budget in integer cents.
 */
export const CONFIG_SCHEMA_VERSION = 2;

/**
 * Unknown top-level keys pass through instead of being silently stripped, so
 * `set("some.custom.key", value)` round-trips and a config written by a newer Trent is
 * not destroyed by an older one.
 */
export const TrentConfigSchema = z.object({
  version: z.number().int().nonnegative().default(CONFIG_SCHEMA_VERSION),
  profile: z.string().default("default"),
  provider: ProviderSchema.default("openai"),
  model: z.string().default("gpt-5.6-terra"),
  toolsets: z.array(ToolsetSchema).default(["file_ops", "terminal"]),
  disabled_toolsets: z.array(ToolsetSchema).default([]),
  budget: BudgetConfigSchema.default({}),
  terminal: TerminalConfigSchema.default({}),
  egress: EgressConfigSchema.default({}),
  voice: VoiceConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  fleet: FleetConfigSchema.default({}),
  personality: z.string().default("default"),
  theme: z.enum(["dark", "light"]).default("dark"),
}).passthrough();

export type TrentConfig = z.infer<typeof TrentConfigSchema>;

/**
 * Known secret names. `catchall` keeps any other key found in `.env` (for example a
 * provider key added by a newer release) instead of dropping it on parse.
 */
export const TrentSecretsSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  E2B_API_KEY: z.string().optional(),
  DAYTONA_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  SIGNAL_NUMBER: z.string().optional(),
  EMAIL_SMTP_HOST: z.string().optional(),
  EMAIL_SMTP_PORT: z.string().optional(),
  EMAIL_SMTP_USER: z.string().optional(),
  EMAIL_SMTP_PASS: z.string().optional(),
  TEAMS_CLIENT_ID: z.string().optional(),
  TEAMS_CLIENT_SECRET: z.string().optional(),
  TEAMS_TENANT_ID: z.string().optional(),
  TRENT_CLOUD_TOKEN: z.string().optional(),
}).catchall(z.string());

export type TrentSecrets = z.infer<typeof TrentSecretsSchema>;
