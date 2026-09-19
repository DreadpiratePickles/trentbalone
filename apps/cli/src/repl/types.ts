/**
 * The REPL's ports.
 *
 * The store and trace surfaces are declared STRUCTURALLY rather than imported, for the
 * same reason `packages/trent-core` redeclares the apps/web shapes: a value import
 * would tie every REPL module — including the ones a Bun subprocess loads in the
 * restart test — to the package's export map and its whole type graph. The real
 * `StorePort` and `TraceStore` from `@trent/core` satisfy these structurally.
 */

import type { Theme } from "../ui/index.js";
import type { BudgetLedger } from "./budget.js";
import type { ApprovalGate } from "./approvals.js";

// ── store slice ─────────────────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRow {
  id: string;
  companyId: string;
  action: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface JobRunRow {
  id: string;
  type: string;
  status: string;
  companyId: string | null;
  summary: string;
  startedAt: Date;
  /** The row's JSON payload (`{ runId, action, stepId }` on an orchestration step; `{ retryOf, runId }` on a retry link). */
  metadata?: Record<string, unknown>;
}

export interface RunRow {
  id: string;
  companyId: string;
  objective: string;
  status: string;
  summary: string | null;
  startedAt: Date;
}

export interface StepRow {
  id: string;
  runId: string;
  seq: number;
  title: string;
  agentRole: string;
  status: string;
  output: string | null;
  costCents: number | null;
}

/**
 * Exactly the store operations the REPL uses.
 *
 * Note the absence of a `listApprovals`: `StorePort` deliberately has none, so the gate
 * keeps its own durable index (see approvals.ts) rather than widening the port.
 */
export interface ReplStore {
  createApproval(input: {
    companyId: string;
    action: string;
    reason: string;
    toolName?: string | null;
    previewContent?: string | null;
  }): Promise<ApprovalRow>;
  getApproval(id: string): Promise<ApprovalRow | null>;
  resolveApproval(id: string, status: "approved" | "rejected"): Promise<ApprovalRow>;
  createJobRun(input: {
    type: string;
    trigger: string;
    companyId?: string | null;
    summary?: string;
    metadata?: Record<string, unknown>;
  }): Promise<JobRunRow>;
  listJobRuns(companyId: string | null, limit?: number): Promise<JobRunRow[]>;
  getRun(id: string): Promise<RunRow | null>;
  listSteps(runId: string): Promise<StepRow[]>;
}

// ── trace slice ─────────────────────────────────────────────────────────────

export interface TraceRow {
  id: string;
  companyId: string;
  runId: string;
  taskType: string;
  agentRole: string;
  stepTitle: string;
  status: string;
  costCents: number;
  latencyMs?: number;
  critiqueVerdict?: string;
  createdAt: string;
}

export interface ReplTraceStore {
  query(companyId: string, taskType?: string): Promise<TraceRow[]>;
  byRun(runId: string): Promise<TraceRow[]>;
}

// ── config slice ────────────────────────────────────────────────────────────

/** The configuration keys the REPL reads. `TrentConfig` satisfies this structurally. */
export interface ReplConfig {
  provider: string;
  model: string;
  budget: { daily_cap: number; currency: string; per_run_cap: number; alert_thresholds: number[] };
  terminal: { backend: string };
  fleet: { installed_agents?: string[]; active_agents: string[]; default_agent: string };
  [key: string]: unknown;
}

/** One MCP connector as it is written into config under `mcp.servers`. */
export interface McpServerConfig {
  id: string;
  transport?: string;
  url?: string;
  command?: string;
  enabled?: boolean;
  trust?: string;
}

// ── tools slice ─────────────────────────────────────────────────────────────

/** A registered toolset adapter as `/tools` lists it: the catalog name and the tool names it answers to. */
export interface ReplToolListing {
  readonly name: string;
  readonly scopes: readonly string[];
}

/** Where the toolsets run this session, as resolved at start (not as configured). */
export interface ReplSandbox {
  readonly backend: "docker" | "local";
  readonly image?: string;
  /** Why this is not what config said, if it is not. */
  readonly note?: string;
}

/** The egress proxy for this session: on (with its loopback port), off by config, or failed to start. */
export interface ReplEgressStatus {
  readonly state: "on" | "off" | "failed";
  readonly port?: number;
  readonly error?: string;
}

// ── context slice (A1.2) ────────────────────────────────────────────────────

/**
 * What the wrapper measured for one seat call: the three tier sizes, the estimate, the ceiling and
 * what the ceiling removed. Declared structurally for the same reason the store slice is —
 * `AssembledContext` from `@trent/core/fleet-memory` satisfies it, and `/context` needs nothing else.
 */
export interface ContextMeasurement {
  readonly stableChars: number;
  readonly contextChars: number;
  readonly volatileChars: number;
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly ceilingChars: number;
  /** Assembled chars over the ceiling BEFORE trimming; 1.0 is exactly at the ceiling. */
  readonly pressure: number;
  /** Names of the blocks the ceiling dropped, oldest first. */
  readonly dropped: readonly string[];
  readonly overCeiling: boolean;
}

/** The fleet-memory hook, as `/context` reads it. */
export interface ContextInspector {
  contextFor(runId: string, seat: string): ContextMeasurement | undefined;
}

/** One run this session started and the seats that ran in it, both oldest first. */
export interface ContextRunSeats {
  readonly runId: string;
  readonly seats: readonly string[];
}

// ── checkpoints slice (E1) ──────────────────────────────────────────────────

/** One turn's checkpoint as `/checkpoints` lists it. `Checkpoint` from @trent/core satisfies it. */
export interface ReplCheckpoint {
  readonly turn: number;
  readonly at: string;
  /** Workspace-relative paths the turn wrote, first touch first. */
  readonly files: readonly string[];
}

/** What a rollback did, or refused to do. `RollbackResult` from @trent/core satisfies it. */
export interface ReplRollbackResult {
  readonly ok: boolean;
  readonly to: number;
  readonly forced: boolean;
  /** `hash` is null where the rollback deleted a file the agent had created. */
  readonly restored: readonly { readonly path: string; readonly hash: string | null }[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * The session's agent-write ledger (`/checkpoints`, `/rollback`). `CheckpointSession` from
 * `@trent/core/checkpoints` satisfies this structurally; when nothing supplies it the commands
 * fall back to the process's open session, so a runtime that opens one needs no REPL wiring.
 */
export interface ReplCheckpointsPort {
  readonly runId: string;
  listCheckpoints(): readonly ReplCheckpoint[];
  /** `to` is the turn whose writes are KEPT; everything after it is undone. */
  rollback(input: { to: number; force?: boolean }): ReplRollbackResult;
}

// ── the shared context every slash command reads ────────────────────────────

export interface ReplContext {
  theme: Theme;
  config: ReplConfig;
  store: ReplStore;
  companyId: string;
  traces: ReplTraceStore;
  budget: BudgetLedger;
  approvals: ApprovalGate;
  degraded: boolean;
  /** Ids of the runs this session has started, newest last. */
  runIds?: string[];
  /** The adapters actually registered with the orchestrator; `/tools` lists these, not the config. */
  tools?: readonly ReplToolListing[];
  sandbox?: ReplSandbox;
  egress?: ReplEgressStatus;
  /** A1.2: the wrapper's own measurement of what it injected, for `/context`. */
  contextInspector?: ContextInspector;
  /** The runs this session has started and the seats each of them used, oldest first. */
  contextRuns?: readonly ContextRunSeats[];
  /** How many times this session's stored transcript has been compacted. */
  compactions?: number;
  /** The fleet, as `trent fleet list` reads it (`/fleet`). */
  fleet?: ReplFleetPort;
  /** The skills store (`/skills`). */
  skills?: ReplSkillsPort;
  /** The personalities and the active one (`/personality`). */
  personalities?: ReplPersonalityPort;
  /** The saved sessions (`/sessions`). */
  sessions?: ReplSessionsPort;
  /** E1: the agent-write ledger this session records into (`/checkpoints`, `/rollback`). */
  checkpoints?: ReplCheckpointsPort;
}

// ── the ports the commands merged out of `apps/cli/src/slash/` read ──────────

/** One agent as `/fleet` lists it. `FleetAgentSummary` satisfies this structurally. */
export interface ReplFleetAgent {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly status: string;
  readonly modelPolicy: string;
  readonly installed: boolean;
  readonly active: boolean;
}

/** `FleetManager` satisfies this structurally; money stays in integer cents. */
export interface ReplFleetPort {
  getStatus(): {
    readonly totalCatalog: number;
    readonly installedCount: number;
    readonly activeCount: number;
    readonly dailyBudgetSpentCents: number;
    readonly dailyBudgetCapCents: number;
    readonly agents: readonly ReplFleetAgent[];
  };
}

/** `SkillsHub` satisfies this structurally. `/skills` reads; installing is `trent skills install`. */
export interface ReplSkillsPort {
  browse(): readonly { readonly slug: string; readonly category: string; readonly description: string }[];
  search(term: string): readonly { readonly slug: string; readonly description: string }[];
  listInstalled(): readonly { readonly slug: string; readonly slashCommand: string; readonly description: string }[];
}

/** `PersonalityManager` satisfies this structurally. */
export interface ReplPersonalityPort {
  list(): readonly { readonly name: string; readonly description: string }[];
  getActivePersonality(): { readonly name: string };
  setPersonality(name: string): { readonly name: string };
}

/** `SessionManager` satisfies this structurally. Cents, never the derived dollars view. */
export interface ReplSessionsPort {
  listSessions(): readonly {
    readonly id: string;
    readonly title: string;
    readonly messages: readonly unknown[];
    readonly total_cost_cents: number;
  }[];
}
