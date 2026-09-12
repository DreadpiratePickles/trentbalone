import type { TrentConfig } from "./schema.js";

export const DEFAULT_CONFIG: TrentConfig = {
  version: "1.0.0",
  profile: "default",
  provider: "openai",
  model: "gpt-5.6-terra",
  toolsets: ["file_ops", "terminal"],
  disabled_toolsets: [],
  budget: {
    daily_cap: 10.0,
    currency: "USD",
    per_run_cap: 1.0,
    alert_thresholds: [50, 80, 100],
  },
  terminal: {
    backend: "docker",
    docker: {
      image: "trent-sandbox:latest",
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
  voice: {
    enabled: false,
    model: "base",
    trigger_key: "Ctrl+B",
    tts_enabled: false,
  },
  gateway: {
    enabled: false,
    platforms: [],
    routes: {},
  },
  fleet: {
    installed_agents: ["ceo", "eng-ai-engineer", "support-responder"],
    active_agents: ["ceo"],
    default_agent: "ceo",
  },
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
