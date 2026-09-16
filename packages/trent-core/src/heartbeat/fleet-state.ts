/**
 * The compact fleet-state block appended to the heartbeat objective: what the profile's own
 * files say right now. Pending approvals come from the gateway store, the last cron runs from
 * `<profile>/cron/runs/*.jsonl`, the budget line from an injected port, and the last heartbeat
 * outcome from the loop's own history. Every reader tolerates a missing or unreadable file:
 * a heartbeat must never fail because a state file is absent.
 */
import fs from "node:fs";
import path from "node:path";
import { readCronRuns, type CronRunRow } from "../cron/CronRunner.js";
import { FileGatewayStore } from "../gateway/store/GatewayStore.js";

/** The budget as the heartbeat reads it: integer cents. `AlertBudgetPort` satisfies it. */
export interface HeartbeatBudgetPort {
  spentCents(): number;
  limitCents(): number;
}

export interface FleetStateDeps {
  readonly profileDir: string;
  readonly budget?: HeartbeatBudgetPort | undefined;
  /** The previous heartbeat row, rendered as `<at> <decision>`; absent on the first tick. */
  readonly lastHeartbeat?: { at: string; decision: string } | undefined;
  /** How many recent cron rows to list; the newest per job, across jobs. */
  readonly cronRows?: number;
}

const DEFAULT_CRON_ROWS = 5;
const SUMMARY_CHARS = 120;
const CENTS_PER_UNIT = 100;

function dollars(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `$${Math.floor(abs / CENTS_PER_UNIT)}.${String(abs % CENTS_PER_UNIT).padStart(2, "0")}`;
}

function pendingApprovals(profileDir: string): number | undefined {
  try {
    const state = new FileGatewayStore(path.join(profileDir, "gateway.json")).snapshot();
    return Object.values(state.approvals).filter((row) => row.status === "pending").length;
  } catch {
    return undefined;
  }
}

/** The newest row of every job, newest first, at most `limit`. */
export function recentCronRuns(profileDir: string, limit = DEFAULT_CRON_ROWS): Array<{ jobId: string; row: CronRunRow }> {
  const dir = path.join(profileDir, "cron", "runs");
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ jobId: string; row: CronRunRow }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const jobId = entry.name.slice(0, -".jsonl".length);
    try {
      const rows = readCronRuns(profileDir, jobId);
      const last = rows[rows.length - 1];
      if (last !== undefined) out.push({ jobId, row: last });
    } catch {
      // An unreadable history is left out; the heartbeat still runs.
    }
  }
  return out.sort((a, b) => b.row.startedAt.localeCompare(a.row.startedAt)).slice(0, limit);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS - 3)}...` : flat;
}

/** The markdown block. Deterministic for a given profile state, so a test can assert on it. */
export function renderFleetState(deps: FleetStateDeps): string {
  const lines = ["## Fleet state"];
  const approvals = pendingApprovals(deps.profileDir);
  lines.push(`- Pending approvals: ${approvals === undefined ? "unknown (gateway store unreadable)" : approvals}`);
  if (deps.budget !== undefined) {
    const spent = deps.budget.spentCents();
    const limit = deps.budget.limitCents();
    const percent = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    lines.push(`- Budget: ${dollars(spent)} of ${dollars(limit)} (${percent}%)`);
  }
  const runs = recentCronRuns(deps.profileDir, deps.cronRows);
  if (runs.length === 0) lines.push("- Recent cron runs: none");
  else {
    lines.push("- Recent cron runs:");
    for (const { jobId, row } of runs) lines.push(`  - ${jobId} ${row.status} at ${row.startedAt}: ${oneLine(row.summary) || "(no summary)"}`);
  }
  lines.push(`- Last heartbeat: ${deps.lastHeartbeat === undefined ? "none" : `${deps.lastHeartbeat.at} ${deps.lastHeartbeat.decision}`}`);
  return lines.join("\n");
}
