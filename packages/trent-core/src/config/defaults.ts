import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import type { TrentConfig } from "./schema.js";
import { CONFIG_SCHEMA_VERSION } from "./schema.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";

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
  toolsets: ["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins", "human"],
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
  runtime: { max_concurrent_runs: 2 },
  heartbeat: { enabled: false, interval_minutes: 60, consolidate_memory: true },
  fleet: {
    installed_agents: ["ceo", "eng-ai-engineer", "sup-support-responder"],
    active_agents: ["ceo"],
    default_agent: "ceo",
  },
  memory: { blocks: [...DEFAULT_MEMORY_BLOCKS] },
  mcp_servers: {},
  telemetry: { service_name: "trent" },
  model_overrides: {},
  privacy: { redact_prompts: false, patterns: [] },
  policy: { rules: [] },
  personality: "default",
  // [A2.1] workspace context
  // Per-file and whole-set caps on the workspace's instruction files. Mirrors the schema's
  // defaults; `workspace-context/types.ts` holds the same two numbers for callers that load
  // without a config.
  workspace: { max_file_chars: 12_000, max_total_chars: 24_000 },
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
    "human",
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
