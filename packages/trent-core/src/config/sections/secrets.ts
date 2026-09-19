/**
 * `TrentSecretsSchema` — the `.env` side of a profile, kept beside the config sections and
 * re-exported from `config/schema.ts`. Values never enter a log, a commit or a config file.
 */

import { z } from "zod";

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
