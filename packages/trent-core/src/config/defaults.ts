import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import type { TrentConfig } from "./schema.js";
import { CONFIG_SCHEMA_VERSION } from "./schema.js";

/** Money fields are INTEGER CENTS. daily_cap 1000 = USD 10.00 per day. */
export const DEFAULT_CONFIG: TrentConfig = {
  version: CONFIG_SCHEMA_VERSION,
  profile: "default",
  // Cheapest tier that answers on a fresh Google key today. Verified 2026-09-12 through the
  // OpenAI-compatible endpoint the gateway actually uses: gemini-2.5-flash is retired for new
  // users (404), gemini-3.6-flash is rate-limited on the free tier (429), this one returns 200.
  provider: "google",
  model: "gemini-3.5-flash-lite",
  // Quick setup enables every toolset that is actually implemented (tools/index.ts
  // IMPLEMENTED_TOOLSETS), the way Hermes's CLI bundle does. Blank-slate mode below is the
  // explicit opt-out. web is skipped with a visible reason while the egress proxy is off.
  toolsets: ["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins"],
  disabled_toolsets: [],
  budget: {
    daily_cap: 1000,
    currency: "USD",
    per_run_cap: 100,
    alert_thresholds: [50, 80, 100],
  },
  terminal: {
    backend: "docker",
    docker: {
      image: SANDBOX_IMAGE,
      network: "bridge",
    },
    ssh: {
      port: 22,
    },
  },
  egress: {
    enabled: true,
    proxy_port: 8089,
    auto_token: true,
    intercept_domains: [
      "api.openai.com",
      "api.anthropic.com",
      "generativelanguage.googleapis.com",
    ],
  },
  gateway: {
    enabled: false,
    platforms: [],
    routes: {},
    double_text_policy: "enqueue",
    alerts: { approval_wait_minutes: 30 },
  },
  repl: { double_text_policy: "enqueue" },
  fleet: {
    installed_agents: ["ceo", "eng-ai-engineer", "sup-support-responder"],
    active_agents: ["ceo"],
    default_agent: "ceo",
  },
  mcp_servers: {},
  telemetry: { service_name: "trent" },
  privacy: { redact_prompts: false, patterns: [] },
  policy: { rules: [] },
  personality: "default",
  theme: "dark",
};

export const BLANK_SLATE_CONFIG: TrentConfig = {
  ...DEFAULT_CONFIG,
  toolsets: ["file_ops", "terminal"],
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
  ],
  egress: {
    ...DEFAULT_CONFIG.egress,
    enabled: false,
  },
  fleet: {
    installed_agents: ["ceo"],
    active_agents: ["ceo"],
    default_agent: "ceo",
  },
};

/** Deep copy so callers can never mutate the shared default objects. */
export function cloneConfig(config: TrentConfig): TrentConfig {
  return structuredClone(config);
}
