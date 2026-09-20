/**
 * `config.yaml`, composed.
 *
 * The sub-schemas live one per subject under `config/sections/`, each carrying its own prose and
 * its task markers; this file holds only `CONFIG_SCHEMA_VERSION`, the composition of
 * `TrentConfigSchema` in its on-disk KEY ORDER, and a re-export of every name that was exported
 * from here before the split, so no import anywhere else changes. `schema-split.test.ts` pins the
 * parsed output and that key order against a snapshot taken before the sections moved.
 *
 * A new top-level key belongs in a section module, imported and named on one line below.
 */

import { z } from "zod";
import { TelemetryConfigSchema } from "./telemetry-schema.js";
import { CheckpointsConfigSchema } from "../checkpoints/config-schema.js";
import { BrainConfigSchema } from "./sections/brain.js";
import { BudgetConfigSchema, DEFAULT_BUDGET_PER_RUN_CAP } from "./sections/budget.js";
import { ContextConfigSchema, ReplConfigSchema, RuntimeConfigSchema } from "./sections/context.js";
import { FleetConfigSchema } from "./sections/fleet.js";
import { GatewayConfigSchema } from "./sections/gateway.js";
import {
  ApprovalsConfigSchema,
  AutonomyLevelSchema,
  DEFAULT_AUTONOMY,
  HooksConfigSchema,
  PolicyConfigSchema,
  PrivacyConfigSchema,
} from "./sections/governance.js";
import { HeartbeatConfigSchema } from "./sections/heartbeat.js";
import { ImproveConfigSchema } from "./sections/improve.js";
import {
  MCP_SERVER_NAME_PATTERN,
  McpHttpServerSchema,
  McpServerConfigSchema,
  McpServersConfigSchema,
  McpStdioServerSchema,
} from "./sections/mcp-servers.js";
import { EmbedderConfigSchema, MemoryBlockSchema, MemoryConfigSchema, MemoryGatesConfigSchema } from "./sections/memory.js";
import { ModelOverrideSchema, ModelTiersConfigSchema, ProviderSchema } from "./sections/models.js";
import { TrentSecretsSchema } from "./sections/secrets.js";
import { EgressConfigSchema, TerminalBackendSchema, TerminalConfigSchema } from "./sections/terminal.js";
import { ToolDisclosureConfigSchema, ToolsetSchema } from "./sections/tools.js";
import { WorkspaceConfigSchema } from "./sections/workspace.js";
import { GoalsConfigSchema } from "../goals/config-schema.js";
// [U1] class floor
import { GateConfigSchema } from "../governance/gate-config-schema.js";
import { MediaConfigSchema } from "./sections/media.js";
// [W3] retrieval gate
import { RetrievalGateConfigSchema } from "../improve/retrieval-config-schema.js";
// [X4] cron incidents
import { CronConfigSchema } from "../cron/config-schema.js";

/** Every name this module exported before the sections moved out; importers are unaffected. */
export {
  BudgetConfigSchema,
  DEFAULT_BUDGET_PER_RUN_CAP,
  EgressConfigSchema,
  EmbedderConfigSchema,
  FleetConfigSchema,
  GatewayConfigSchema,
  HeartbeatConfigSchema,
  MCP_SERVER_NAME_PATTERN,
  McpHttpServerSchema,
  McpServerConfigSchema,
  McpServersConfigSchema,
  McpStdioServerSchema,
  MemoryBlockSchema,
  MemoryConfigSchema,
  ModelOverrideSchema,
  ProviderSchema,
  TerminalBackendSchema,
  TerminalConfigSchema,
  ToolsetSchema,
  TrentSecretsSchema,
};
export type { EmbedderConfig, MemoryBlockConfig } from "./sections/memory.js";
export type { HeartbeatConfig } from "./sections/heartbeat.js";
export type { McpServerConfig, McpServersConfig } from "./sections/mcp-servers.js";
export type { ModelOverride, Provider } from "./sections/models.js";
export type { TerminalBackendType } from "./sections/terminal.js";
export type { Toolset } from "./sections/tools.js";
export type { TrentSecrets } from "./sections/secrets.js";

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
  repl: ReplConfigSchema.default({}),
  context: ContextConfigSchema.default({}),
  runtime: RuntimeConfigSchema.default({}),
  heartbeat: HeartbeatConfigSchema.default({}),
  fleet: FleetConfigSchema.default({}),
  mcp_servers: McpServersConfigSchema.default({}),
  telemetry: TelemetryConfigSchema.default({}),
  model_overrides: z.record(z.string().min(1), ModelOverrideSchema).default({}),
  privacy: PrivacyConfigSchema.default({}),
  policy: PolicyConfigSchema.default({}),
  workspace: WorkspaceConfigSchema.default({}),
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
  memory: MemoryGatesConfigSchema.default({}),
  models: ModelTiersConfigSchema.default({}),
  tools: ToolDisclosureConfigSchema.default({}),
  brain: BrainConfigSchema.default({}),
  // [E1] checkpoints: the agent-write ledger behind `/checkpoints` and `/rollback`, defined beside
  // the ledger that reads it (`checkpoints/config-schema.ts`, docs/checkpoints.md).
  checkpoints: CheckpointsConfigSchema.default({}),
  // [/E1]
  // [D3] curator
  /**
   * The skill curator (docs/skills.md, "Curator"). `enabled` false means no aging pass ever runs;
   * `trent curator status` and `log` still read, because seeing what the curator would do is not
   * curation. `stale_after_days` and `archive_after_days` are measured from the last LOAD of a
   * skill by a seat's run, not from when it was written, and only skills declared
   * `created_by: agent` are ever aged by them — a skill a person installed is reported and left
   * alone however old it gets. `scan_agent_skills` is the second scan gate: the composed skill,
   * its document and its whole bundle together, put past the pre-install scanner after every
   * agent write, with a flagged skill held `quarantined` until a human releases it. Turning it
   * off would leave only the per-operation write scan, which no single operation sees the whole
   * of — but the toolset builder does not pass this setting into the adapter yet, so the gate is
   * on regardless of what is written here.
   */
  curator: z
    .object({
      enabled: z.boolean().default(true),
      stale_after_days: z.number().int().positive().default(60),
      archive_after_days: z.number().int().positive().default(180),
      scan_agent_skills: z.boolean().default(true),
    })
    .strict()
    .default({}),
  // [C5] provenance
  /**
   * What output derived from untrusted context may do (docs/security.md, "Prompt injection";
   * `governance/provenance.ts`). Untrusted means the web and browser toolsets, MCP servers,
   * plugin tools, and a delegated child that used any of them.
   *
   * `untrusted_writes` governs a write into a layer every seat loads next run — the `memory` tool
   * today, a brain write when one exists. `hold` is the shipped rule: the write becomes a pending
   * approval row on the durable approval path, named with the tools it came from, and lands only
   * when the founder approves it, carrying `[provenance: untrusted via <tools>]` in the entry
   * itself. `deny` refuses it outright; `allow` writes it tagged and is the setting that reopens
   * the memory-poisoning path the research names, so it is a deliberate choice and not a default.
   *
   * `untrusted_skills` governs `skill_manage` from such a step. `deny` is the shipped rule,
   * because a skill is executable content a later seat runs without reading it. It is refused
   * with the reason named; quarantining a candidate instead is the curator's job, not this gate's.
   *
   * The block is NOT a filter: nothing here inspects untrusted text for an instruction, because
   * that detection is unsolved (research item F12). It gates the combination of untrusted input
   * and a durable write, which is what F13 recommends and what B14 already ships.
   */
  provenance: z
    .object({
      untrusted_writes: z.enum(["hold", "allow", "deny"]).default("hold"),
      untrusted_skills: z.enum(["deny", "allow"]).default("deny"),
    })
    .strict()
    .default({}),
  // [D4] goals: gates before the judge, and verify_on_stop (`goals/config-schema.ts`, docs/goals.md).
  goals: GoalsConfigSchema.default({}),
  // [U1] class floor
  /** The side-effect gate (docs/security.md, "Side-effecting tools: the gate"): `ask_classes` adds to the shipped floor and nothing removes from it. */
  gate: GateConfigSchema.default({}),
  // [B2] media: the local clip pipeline and its transcription opt-in (`sections/media.ts`, docs/media.md).
  media: MediaConfigSchema.default({}),
  // [W3] retrieval gate
  /** The recall floor the improve loop and `trent improve retrieval` hold the ranker to (`improve/retrieval-config-schema.ts`, docs/improve.md). */
  retrieval: RetrievalGateConfigSchema.default({}),
  // [X4] cron incidents
  /** The runner's incident threshold and quota hold (`cron/config-schema.ts`, docs/cron.md "Incidents"). */
  cron: CronConfigSchema.default({}),
  personality: z.string().default("default"),
  theme: z.enum(["dark", "light"]).default("dark"),
  improve: ImproveConfigSchema.default({}),
}).passthrough();

export type TrentConfig = z.infer<typeof TrentConfigSchema>;
