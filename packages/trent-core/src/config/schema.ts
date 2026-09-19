import { z } from "zod";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import { TelemetryConfigSchema } from "./telemetry-schema.js";
import { PolicyRuleSchema } from "../governance/policy-rules.js";
import { DEFAULT_MEMORY_BLOCKS, MEMORY_BLOCK_LABEL_PATTERN } from "../tools/memory/blocks.js";
import { McpScanFindingSchema } from "../tools/mcp/scan.js";
// [A2.2] autonomy and hooks
import { ApprovalsConfigSchema, AutonomyLevelSchema, DEFAULT_AUTONOMY } from "../governance/autonomy.js";
import { HooksConfigSchema } from "../hooks/types.js";

/**
 * The five provider identities `apps/web` routes natively, then the four OpenAI-compatible
 * endpoints the gateway resolves at the boundary (`model-gateway/providers.ts`) into `openai`
 * plus a base URL. Every name here must be routable: `providers-schema.test.ts` fails if one is
 * accepted by this enum and reaches no model.
 */
export const ProviderSchema = z.enum([
  "openai",
  "anthropic",
  "google",
  "mistral",
  "openrouter",
  "deepseek",
  "groq",
  "ollama",
  "lmstudio",
]);

export type Provider = z.infer<typeof ProviderSchema>;

/**
 * A per-model price and context window that beats the gateway's shipped table
 * (`model-gateway/pricing.ts`). Rates are CENTS per million tokens — the computed cost is still
 * integer cents — so a $3.00/1M list price is written as 300.
 */
export const ModelOverrideSchema = z.object({
  context_window: z.number().int().positive().optional(),
  input_cents_per_million: z.number().nonnegative().optional(),
  output_cents_per_million: z.number().nonnegative().optional(),
}).strict();

export type ModelOverride = z.infer<typeof ModelOverrideSchema>;

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
  "human",
]);

export type Toolset = z.infer<typeof ToolsetSchema>;

export const TerminalBackendSchema = z.enum(["docker", "local"]);
export type TerminalBackendType = z.infer<typeof TerminalBackendSchema>;

/**
 * Money is INTEGER CENTS everywhere, never floating-point dollars — this matches the
 * rule the rest of the platform already follows. `daily_cap: 1000` is USD 10.00.
 * `alert_thresholds` stays a list of PERCENTAGES, not money.
 */
/** Integer cents. Named because `improve.sweep_cap_cents` defaults to it (plan decision 8). */
export const DEFAULT_BUDGET_PER_RUN_CAP = 100;

export const BudgetConfigSchema = z.object({
  daily_cap: z.number().int().positive().default(1000),
  currency: z.string().default("USD"),
  per_run_cap: z.number().int().positive().default(DEFAULT_BUDGET_PER_RUN_CAP),
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

export const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  platforms: z.array(z.string()).default([]),
  routes: z.record(z.string(), z.string()).default({}), // platform -> agentId
  /** What a second message on a busy chat does: queue it, interrupt the running turn, or refuse it. */
  double_text_policy: z.enum(["enqueue", "interrupt", "reject"]).default("enqueue"),
  /** Who receives approval cards and heartbeat messages: a platform id and a channel on it. */
  owner: z.object({ platform: z.string(), channelId: z.string() }).optional(),
  /** Push alerts to `owner`: how long a gate may wait unanswered before one reminder is sent. */
  alerts: z.object({ approval_wait_minutes: z.number().int().positive().default(30) }).default({}),
});

/**
 * The heartbeat: a model turn over `<profile>/HEARTBEAT.md` every `interval_minutes`, skipped
 * inside quiet hours (outside `active_hours`, read on the wall clock of `tz`), with the reply
 * delivered to `gateway.owner` unless it is exactly `NO_REPLY`.
 */
export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  interval_minutes: z.number().int().positive().default(60),
  active_hours: z.object({ start: z.string(), end: z.string(), tz: z.string().default("UTC") }).optional(),
  consolidate_memory: z.boolean().default(true),
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

/**
 * `memory.blocks`: the named memory blocks every seat reads in its prelude (T4.3). Each is one
 * file under `<profile>/memories/` with its own character limit; `read_only` blocks are written
 * by the founder or the heartbeat, never by a seat. Defaults: `memory`, `user`, `company`.
 */
export const MemoryBlockSchema = z.object({
  label: z.string().regex(MEMORY_BLOCK_LABEL_PATTERN),
  file: z.string().min(1),
  description: z.string().min(1),
  limit: z.number().int().positive(),
  read_only: z.boolean().default(false),
});
export type MemoryBlockConfig = z.infer<typeof MemoryBlockSchema>;
// [C3] embedder
/**
 * `memory.embedder`: what ranks fleet recall. Lexical TF-IDF always runs; with an embedder the
 * score is the documented blend of it and the embedding cosine (`fleet-memory/hybrid.ts`).
 * `auto` is the first provider with a key, preferring the one `provider` already routes chat
 * through; `none` is lexical only and is what an operator with no key gets anyway. `model`
 * overrides the route default, `batch_size` bounds one request. `trent doctor` names the live
 * choice. See docs/configuration.md, "Embedder".
 */
export const EmbedderConfigSchema = z.object({
  provider: z.enum(["auto", "gemini", "openai", "none"]).default("auto"),
  model: z.string().min(1).optional(),
  batch_size: z.number().int().positive().max(256).default(32),
});
export type EmbedderConfig = z.infer<typeof EmbedderConfigSchema>;
export const MemoryConfigSchema = z.object({
  blocks: z.array(MemoryBlockSchema).default([...DEFAULT_MEMORY_BLOCKS]),
  embedder: EmbedderConfigSchema.default({}),
});
// [/C3]

export const FleetConfigSchema = z.object({
  installed_agents: z.array(z.string()).default(["ceo", "eng-ai-engineer", "support-responder"]),
  active_agents: z.array(z.string()).default(["ceo"]),
  default_agent: z.string().default("ceo"),
});

/**
 * `mcp_servers`: one entry per Model Context Protocol server, keyed by a name that becomes the
 * middle of every exposed tool name (`mcp_<server>_<tool>`). Hermes's `~/.hermes/config.yaml`
 * uses the same block (`{command,args,env}` for stdio, `{url,headers}` for http); `transport` is
 * inferred from which of those is present when it is omitted. `env` and `headers` VALUES may
 * reference `${ENV_VAR}`, resolved from the process env at connect time and never stored resolved.
 * `auto_approve` lists the server's tools (its own names) that may run without approval.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,40}$/;

const McpServerCommonSchema = z.object({
  auto_approve: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** Install-time scan record (`trent mcp add`): whether the scan ran, and the findings it was installed over with `--allow-flagged`. */
  scanRan: z.boolean().optional(),
  flagged: z.array(McpScanFindingSchema).optional(),
});

export const McpStdioServerSchema = McpServerCommonSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
});

export const McpHttpServerSchema = McpServerCommonSchema.extend({
  transport: z.literal("http"),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: "url must be http(s)" }),
  headers: z.record(z.string().min(1), z.string()).default({}),
});

export const McpServerConfigSchema = z.discriminatedUnion("transport", [McpStdioServerSchema, McpHttpServerSchema]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Infers `transport`, and lifts the legacy `[{name, url}]` array the old CLI wrote into the record. */
function normaliseMcpServers(raw: unknown): unknown {
  let entries: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isRecord(item) && typeof item.name === "string" && typeof item.url === "string") entries[item.name] = { url: item.url };
    }
  } else if (isRecord(raw)) entries = raw;
  else return raw;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!isRecord(value) || typeof value.transport === "string") {
      out[name] = value;
      continue;
    }
    out[name] = { ...value, transport: typeof value.url === "string" ? "http" : "stdio" };
  }
  return out;
}

export const McpServersConfigSchema = z.preprocess(
  normaliseMcpServers,
  z.record(z.string().regex(MCP_SERVER_NAME_PATTERN, "server name must match ^[a-z][a-z0-9_-]{1,40}$"), McpServerConfigSchema),
);
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;

/**
 * Integer on-disk schema version for `config.yaml`. Bump this and add a step to
 * `migrate.ts` whenever the stored shape changes.
 *   1 -> pre-versioned layout, budget in float dollars.
 *   2 -> integer `version` key, budget in integer cents.
 *   3 -> terminal.backend ssh|e2b collapsed to docker (the mock backends are gone).
 */
export const CONFIG_SCHEMA_VERSION = 3;

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
  toolsets: z.array(ToolsetSchema).default(["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins", "human"]),
  disabled_toolsets: z.array(ToolsetSchema).default([]),
  budget: BudgetConfigSchema.default({}),
  terminal: TerminalConfigSchema.default({}),
  egress: EgressConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  // [A1] context management
  // `history_turns` / `history_chars` were read by `apps/cli/src/repl/conversation.ts` and never
  // declared here, so zod stripped both on every load and the profile's setting did nothing.
  // `history_chars` is the ONE name for "what the next run may be told"; compaction is keyed off it.
  repl: z.object({
    double_text_policy: z.enum(["enqueue", "interrupt", "reject"]).default("enqueue"),
    history_turns: z.number().int().positive().default(8),
    history_chars: z.number().int().positive().default(6000),
  }).default({}),
  /**
   * `ceiling_chars` bounds everything the wrapper injects into a seat prompt (the three tiers of
   * `fleet-memory/tiers.ts`); over it, the context and volatile tiers are trimmed oldest-first and
   * the stable tier never is. `compact_after_chars` is where a stored transcript is compacted;
   * omitted, it is `repl.history_chars * 2`. Characters, not tokens: a ceiling must be checkable
   * offline and identically on every provider (docs/configuration.md, "Context management").
   */
  context: z.object({
    ceiling_chars: z.number().int().positive().default(60_000),
    compact_after_chars: z.number().int().positive().optional(),
  }).default({}),
  /** `max_concurrent_runs`: runs driven at once per profile; a run past the cap waits FIFO (docs/jobs.md). */
  runtime: z.object({ max_concurrent_runs: z.number().int().positive().default(2) }).default({}),
  heartbeat: HeartbeatConfigSchema.default({}),
  fleet: FleetConfigSchema.default({}),
  mcp_servers: McpServersConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  /**
   * Per-model price and context-window overrides, keyed by model id. An entry wins over the
   * gateway's table; a model nothing prices is reported `unpriced` on the meter rather than billed
   * at the Anthropic tier (docs/configuration.md, "Model pricing").
   */
  model_overrides: z.record(z.string().min(1), ModelOverrideSchema).default({}),
  /** Prompt-side redaction in the model gateway (docs/security.md, "Prompt redaction"). */
  privacy: z.object({ redact_prompts: z.boolean().default(false), patterns: z.array(z.string()).default([]) }).default({}),
  /** Trace-level rules over tool classes; appended to the shipped defaults, same id overrides. */
  policy: z.object({ rules: z.array(PolicyRuleSchema).default([]) }).default({}),
  // [A2.1] workspace context
  /**
   * Caps on the instruction files Trent reads from the workspace it is run in (`AGENTS.md`,
   * `CLAUDE.md`, `.trent/*.md`). `max_file_chars` bounds one file, `max_total_chars` the set; a
   * file over either is truncated with a marker line, never dropped silently. Trust is not
   * configurable: it lives in `<profile>/workspace-trust.json` and is granted by
   * `trent workspace trust`. See docs/configuration.md, "Workspace context files".
   * The defaults must stay equal to `workspace-context/types.ts`, which is asserted by
   * `workspace-context/workspace-context.test.ts`.
   */
  workspace: z.object({
    max_file_chars: z.number().int().positive().default(12_000),
    max_total_chars: z.number().int().positive().default(24_000),
  }).default({}),
  // [A2.2] autonomy and hooks
  /**
   * How often a human is asked. `ask_dangerous` is today's behaviour and the default: ask exactly
   * where the approval floors already ask. `ask_always` asks for every call that is not a pure
   * read; `never` auto-approves what the floors would have asked about. No level lifts the
   * hardline blocklist (`governance/hardline.ts`), an `approvals.deny` glob, or anything
   * `tools/approval-floors.ts` marks never-auto-approvable. See docs/security.md.
   */
  autonomy: AutonomyLevelSchema.default(DEFAULT_AUTONOMY),
  /** `deny`: globs over the command string and over file paths; a match is refused at every level. */
  approvals: ApprovalsConfigSchema.default({}),
  /**
   * User hooks around tool calls and sessions. Each is an executable and an argument array, never
   * a shell string, and runs only after `trent hooks consent` records a hash of its exact spec.
   */
  hooks: HooksConfigSchema.default({}),
  // [C4] memory gates
  /**
   * The memory blocks and the two gates over writing them (docs/configuration.md, "Memory blocks";
   * `tools/memory/store.ts`, `checkMemoryWriteGate`).
   *
   * `consolidation_may_edit` lists the `read_only` block labels the SCHEDULED consolidation may
   * edit. Empty by default, which is the shipped rule: a read-only block is refused on every write
   * path, seat and consolidation alike. Listing a label lets the nightly draft propose changes to
   * that block; a seat is still refused, and the founder still promotes the draft.
   *
   * `consolidation_max_removal_ratio` is the collapse guard. ACE measured a whole-block rewrite
   * taking a context from 18,282 tokens at 66.7 percent to 122 tokens at 57.1 percent in one step,
   * so at most this share of a block's entries may be removed or merged away in ONE consolidation
   * (never fewer than one, so a three-entry block can still lose its duplicate). A proposal over
   * the ratio is rejected whole and ledgered. It must stay equal to `DEFAULT_MAX_REMOVAL_RATIO`
   * in `fleet-memory/memory-ops.ts`, which `tools/memory/memory.test.ts` asserts.
   */
  memory: MemoryConfigSchema.extend({
    consolidation_may_edit: z.array(z.string().regex(MEMORY_BLOCK_LABEL_PATTERN)).default([]),
    consolidation_max_removal_ratio: z.number().positive().max(1).default(0.3),
  }).default({}),
  // [B2.1] model tiers
  /**
   * `models`: one model id per tier. `orchestrator/model-env.ts` maps these onto the per-provider
   * `*_MODEL_FAST` / `*_MODEL_DEFAULT` / `*_MODEL_STRONG` variables the app's resolver reads, so a
   * seat's manifest tier (`SEAT_MANIFESTS[role].modelTier`) chooses a different model instead of
   * every seat running the one `model` above. `fast` is the haiku tier, `executor` the sonnet tier
   * and `planner` the opus tier; `judge` names the critic's model where a provider has a critic
   * variable of its own (`OPENAI_MODEL_CRITIC`) — the self-improvement loop's judge is a separate
   * key, `improve.judge_model`. A tier nothing names falls back to `executor`, and `executor`
   * itself to `model`, so an untiered profile behaves exactly as it did before this key existed.
   * An operator's own environment variable still wins. See docs/configuration.md, "Model tiers".
   */
  models: z.object({
    fast: z.string().min(1).optional(),
    executor: z.string().min(1).optional(),
    planner: z.string().min(1).optional(),
    judge: z.string().min(1).optional(),
  }).strict().default({}),
  personality: z.string().default("default"),
  theme: z.enum(["dark", "light"]).default("dark"),
  // [D0] improvement gates
  /**
   * The gates the self-improvement loop is held to before any reflection is switched on
   * (docs/improve.md). `holdout_ratio` is the share of every suite's fixtures held back from
   * reflection and scoring and used for promotion alone; `pass_k` is how many consecutive trials
   * a fixture must pass to count as passed; `judge_min_tpr` / `judge_min_tnr` are the calibration
   * floors below which the judge's verdicts are advisory and cannot make a fixture pass;
   * `sweep_cap_cents` is the sweep's hard spend cap in INTEGER CENTS and defaults to
   * `budget.per_run_cap` (plan decision 8); `frozen_paths` are extra paths the loop may never
   * write, on top of the suites, the goldens, the judge prompt and the gate code.
   */
  improve: z.object({
    holdout_ratio: z.number().gt(0).lt(1).default(0.3),
    pass_k: z.number().int().min(1).default(3),
    judge_min_tpr: z.number().min(0).max(1).default(0.8),
    judge_min_tnr: z.number().min(0).max(1).default(0.8),
    sweep_cap_cents: z.number().int().positive().default(DEFAULT_BUDGET_PER_RUN_CAP),
    frozen_paths: z.array(z.string().min(1)).default([]),
    // [D1] judge
    /**
     * Reflection, and who grades it (docs/improve.md, "The judge model" and "Reflection").
     *
     * `judge_model` is the model the eval judge runs on. EMPTY is not "no judge": it means
     * resolve one at run time (`improve/judge-model.ts`) — the configured planner-tier model when
     * it differs from the executor, else the strongest priced Gemini model that does. The judge
     * and the executor may never be the same id; equal models are a configuration error naming
     * both. On one key the two are the same family, which plan decision 6 records as the limit
     * until a second provider key exists.
     *
     * `min_goldens` is how many PROMOTED goldens a seat's suite must hold before `trent improve
     * sweep --live` will spend a model call reflecting for it. Below it the sweep refuses and
     * names the counts: a reflection measured on one or two fixtures is noise with a bill.
     */
    judge_model: z.string().default(""),
    min_goldens: z.number().int().min(1).default(5),
  }).default({}),
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
