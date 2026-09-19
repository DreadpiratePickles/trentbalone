import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import type { TrentConfig } from "./schema.js";
import { CONFIG_SCHEMA_VERSION, DEFAULT_BUDGET_PER_RUN_CAP } from "./schema.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";
// [A2.2] autonomy and hooks
import { DEFAULT_AUTONOMY } from "../governance/autonomy.js";

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
  // [A1] context management
  // `history_chars` is what the next run may be told; `context.ceiling_chars` bounds the whole
  // wrapper injection (memory blocks, skills index, recall, transcript, personality suffix).
  // 60000 chars is ~15000 estimated tokens at the gateway's 4-chars-per-token rate.
  repl: { double_text_policy: "enqueue", history_turns: 8, history_chars: 6000 },
  context: { ceiling_chars: 60_000 },
  runtime: { max_concurrent_runs: 2 },
  heartbeat: { enabled: false, interval_minutes: 60, consolidate_memory: true },
  fleet: {
    installed_agents: ["ceo", "eng-ai-engineer", "sup-support-responder"],
    active_agents: ["ceo"],
    default_agent: "ceo",
  },
  mcp_servers: {},
  telemetry: { service_name: "trent" },
  model_overrides: {},
  privacy: { redact_prompts: false, patterns: [] },
  policy: { rules: [] },
  // [A2.1] workspace context
  // Per-file and whole-set caps on the workspace's instruction files. Mirrors the schema's
  // defaults; `workspace-context/types.ts` holds the same two numbers for callers that load
  // without a config.
  workspace: { max_file_chars: 12_000, max_total_chars: 24_000 },
  // [A2.2] autonomy and hooks
  // `ask_dangerous` is what Trent already did before the level existed: ask exactly where the
  // approval floors ask (file_ops writes, dangerous terminal findings, plugins and mcp without
  // auto_approve, ask_human) and nowhere else. Changing this default changes behaviour silently,
  // so `governance/autonomy.test.ts` asserts it.
  autonomy: DEFAULT_AUTONOMY,
  approvals: { deny: [] },
  hooks: { pre_tool_call: [], post_tool_call: [], session_start: [], session_stop: [] },
  // [C4] memory gates
  // No read-only block is editable by anything but the founder's own editor until its label is
  // listed here, and no single consolidation may take more than 30 percent of a block's entries
  // out (never fewer than one). Both numbers are the shipped rule, not a hint: the writers refuse.
  // [C3] embedder
  // `auto` = the first provider with a key, preferring the family `provider` already routes chat
  // through: a profile with a Gemini or OpenAI key gets hybrid recall with no configuration, and a
  // profile with neither keeps the lexical ranking it already had. 32 inputs per request sits
  // inside both providers' batch limits. See docs/configuration.md, "Embedder".
  memory: { blocks: [...DEFAULT_MEMORY_BLOCKS], consolidation_may_edit: [], consolidation_max_removal_ratio: 0.3, embedder: { provider: "auto", batch_size: 32 } },
  personality: "default",
  theme: "dark",
  // [D0] improvement gates
  // The loop's own gates (docs/improve.md). `sweep_cap_cents` is `budget.per_run_cap` above, in
  // integer cents: a sweep may not outspend one run by accident (plan decision 8), and
  // `config/improve-schema.test.ts` asserts the two stay equal. `pass_k` of 3 triples what a
  // gated candidate costs, which is the price of not promoting a coin flip. Reflection is not
  // configured here because it stays OFF: the CLI sweep passes `skipLLM: true`.
  improve: {
    holdout_ratio: 0.3,
    pass_k: 3,
    judge_min_tpr: 0.8,
    judge_min_tnr: 0.8,
    sweep_cap_cents: DEFAULT_BUDGET_PER_RUN_CAP,
    frozen_paths: [],
  },
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
