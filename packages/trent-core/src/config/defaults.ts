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
    // [P1-A] email auth
    email: { require_authenticated_from: true },
  },
  // [A1] context management
  // `history_chars` is what the next run may be told; `context.ceiling_chars` bounds the whole
  // wrapper injection (memory blocks, skills index, recall, transcript, personality suffix).
  // 60000 chars is ~15000 estimated tokens at the gateway's 4-chars-per-token rate.
  repl: { double_text_policy: "enqueue", history_turns: 8, history_chars: 6000 },
  context: { ceiling_chars: 60_000 },
  runtime: { max_concurrent_runs: 2 },
  heartbeat: {
    enabled: false,
    interval_minutes: 60,
    consolidate_memory: true,
    // [D2] heartbeat sweep
    // Opt-in, and off: a profile that already ticks keeps its exact behaviour and its exact bill
    // until `heartbeat.sweep.enabled` is set. Once a day is the cadence `improve.sweep_cap_cents`
    // was sized for, and the day's ledger must still hold that cap before a sweep starts
    // (docs/heartbeat.md, "Unattended sweeps"). The keys live here, next to the rest of
    // `heartbeat`, because that is the object they belong to.
    sweep: { enabled: false },
    sweep_interval_hours: 24,
    // [/D2]
  },
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
  // [C1] app memory
  // How much of the web app's own company memory a seat may be handed per surface, in characters
  // (`fleet-memory/app-tiers.ts`, `DEFAULT_APP_MEMORY_BUDGETS`, which `app-tiers.test.ts` asserts
  // equal to these). 14,000 in total against a 60,000-char ceiling: the company's facts reach a
  // seat without crowding out the memory blocks, the skills index or the transcript. Zero on one
  // key turns that surface off and leaves the rest alone.
  // [/C1]
  memory: { blocks: [...DEFAULT_MEMORY_BLOCKS], consolidation_may_edit: [], consolidation_max_removal_ratio: 0.3, embedder: { provider: "auto", batch_size: 32 }, app_sources: { tiers: 4_000, documents: 4_000, capabilities: 1_500, registries: 1_500, decisions: 1_500, wiki: 1_500 } },
  // [B2.1] model tiers
  // Empty by default, which is the shipped behaviour: with no tier named, every tier resolves to
  // `model` above and a seat runs exactly what it ran before the key existed. Naming one tier
  // changes that tier alone (docs/configuration.md, "Model tiers").
  models: {},
  // [A3] tool disclosure
  // 24 is the count at which the catalog stops being something a seat can hold in one prompt: the
  // twelve built toolsets are already 40-odd tools, so one MCP server puts any real install over
  // it. It must stay equal to `DEFAULT_DISCLOSURE_THRESHOLD` in `tools/tool_search/index.ts`,
  // which `tools/tool_search/disclosure.test.ts` asserts.
  tools: { disclosure_threshold: 24 },
  // [C2] brain
  // On by default: `<profile>/brain/` is created on the first run, the memory blocks migrate into
  // `brain/system/` once, and git versions every write when git is installed. `versioning: auto`
  // degrades to plain files rather than failing, and the doctor line says which of the two is
  // running. See docs/brain.md.
  brain: { enabled: true, versioning: "auto" },
  // [E1] checkpoints
  // On by default: a rollback is only possible for writes that were ledgered while they happened,
  // so a profile that turns this off is choosing that its agent writes cannot be undone. 50 MB of
  // pre-images per run is the point past which a row keeps its hashes and drops the bytes; it must
  // stay equal to `DEFAULT_MAX_BYTES_PER_RUN` in `checkpoints/types.ts`, which
  // `checkpoints/config.test.ts` asserts. See docs/checkpoints.md.
  checkpoints: { enabled: true, max_bytes_per_run: 50 * 1024 * 1024 },
  // [/E1]
  // [D3] curator
  // On by default, and on by default it does nothing surprising: aging only ever touches skills
  // declared `created_by: agent`, and 60/180 days of no load is a long silence for a skill a seat
  // wrote for itself. Both numbers are measured from the last load, so a skill in weekly use never
  // ages at all. `scan_agent_skills` is the composed-skill gate; a flagged skill is quarantined,
  // never deleted. See docs/skills.md, "Curator".
  curator: { enabled: true, stale_after_days: 60, archive_after_days: 180, scan_agent_skills: true },
  // [C5] provenance
  // Hold, and deny. A memory entry derived from a web page, an MCP server, a plugin or a
  // delegated child that read one of those is parked as a pending approval naming the tools it
  // came from, and lands only when the founder approves it — tagged in the entry itself, so the
  // block says where the line came from for as long as it exists. A skill authored from such a
  // step is refused: it is executable content a later seat runs without reading it. `allow`
  // exists for a profile that trusts its own sources, and reopens the memory-poisoning path
  // deliberately. See docs/security.md, "Prompt injection".
  provenance: { untrusted_writes: "hold", untrusted_skills: "deny" },
  // [D4] goals
  // `verify_on_stop` is on by default, because the failure it prevents — a turn that edited code
  // and then declared itself done — is the cheapest and most repeated failure a coding harness has.
  // `auto_continue` is off by default: a red gate that silently starts another metered run is a
  // bill nobody authorised, and `trent goal continue <id>` is the explicit path. The command list
  // must stay equal to `DEFAULT_VERIFY_COMMANDS` in `goals/types.ts`, which
  // `goals/config.test.ts` asserts. See docs/goals.md.
  goals: {
    verify_on_stop: true,
    verify_commands: ["npm test", "npm run typecheck", "npx vitest", "npx tsc", "pytest", "go test", "cargo test"],
    auto_continue: false,
    max_continuations: 3,
  },
  // [/D4]
  // [U1] class floor
  // Nothing added: the shipped floor (`external_send`, `money_moving`, `customer_facing`) already
  // asks at every level. A profile that wants `deploy` or `destructive` asked about at `never`
  // names it here; no key lowers the floor. See docs/security.md, "Side-effecting tools: the gate".
  gate: { ask_classes: [] },
  // [B2] media: docker when the media image exists, else the host's binaries; no audio leaves
  // the machine until `hosted_transcription` is set by hand (docs/media.md). [W4] Image
  // generation is metered spend: `auto` picks Gemini on its key, the model and the price come
  // from the shipped table, and every image asks until `image_auto_approve_under_cents` lifts it.
  media: {
    backend: "auto",
    hosted_transcription: false,
    whisper_model: "",
    image_provider: "auto",
    image_model: "",
    image_price_cents: 0,
    image_auto_approve_under_cents: 0,
  },
  // [W3] retrieval gate
  // recall@8 over the promoted retrieval goldens below which no draft promotes and `trent improve
  // retrieval` exits non-zero. 0.9 is the trigger design decision E recorded for the deferred
  // reranker and contextual prefixes: under it retrieval is the problem to work on.
  retrieval: { min_recall: 0.9 },
  // [X4] cron incidents
  // Three scheduled failures in a row is one alert; a 429 with no Retry-After holds prompt jobs
  // for half an hour. Both must stay equal to the runner's constants (`cron/incidents.ts`),
  // which `config/cron-schema.test.ts` asserts. See docs/cron.md, "Incidents".
  cron: { failure_alert_after: 3, quota_hold_minutes: 30 },
  // [X5] auto recovery
  // One re-run of a step that failed on a transient provider or tool error, with the error in
  // its prompt; never for an approval park, a budget stop or a refusal. 0 turns it off.
  agent: { auto_recovery_cycles: 1 },
  // [P1-D] connect inherit
  // A second profile reads a `trent connect` provider it never connected from the default
  // profile's secrets file, read-only: one grant per machine, which is what people want.
  connect: { inherit_default: true },
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
    // [D1] judge
    // Reflection is switchable on now (`trent improve sweep --live`), so two things are configured
    // here. An EMPTY `judge_model` means "resolve one at run time" rather than "no judge": the
    // planner tier when it differs from the executor, else the strongest priced Gemini model that
    // does (`improve/judge-model.ts`), because a judge equal to the executor grades its own
    // output. `min_goldens` of 5 is the floor a seat's golden suite must clear before a live sweep
    // will pay for a reflection on it.
    judge_model: "",
    min_goldens: 5,
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
    "media",
    "social",
    "business",
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
