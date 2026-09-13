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
}
