/**
 * [D2] The unattended improvement sweep, as the heartbeat meters it.
 *
 * The loop never builds a sweep: it calls an injected port, so everything the loop is
 * responsible for is here and testable without a store, a gateway or a model. What the loop
 * owns is the METER and the GATES around the sweep:
 *
 *   1. opt-in     `heartbeat.sweep.enabled` is false by default, so an existing profile keeps
 *                 its exact behaviour and its exact bill;
 *   2. quiet      a sweep never starts inside quiet hours, for the same reason a tick does not;
 *   3. interval   at most one every `heartbeat.sweep_interval_hours`, read off the history, so a
 *                 restart cannot buy a second sweep;
 *   4. headroom   the day's ledger (every cost this heartbeat wrote to its own history today,
 *                 against `budget.daily_cap`) must still hold `improve.sweep_cap_cents`, which
 *                 is also the hard cap handed to the sweep itself.
 *
 * A skipped sweep says which of the four stopped it, in the tick's own history row. A sweep that
 * ran leaves the counts, the spend and the cap. Nothing here promotes anything: every draft a
 * sweep produces is in quarantine, and `trent improve promote` is still the human gate.
 */
import type { SweepReport } from "../improve/sweep.js";
import type { HeartbeatBudgetPort } from "./fleet-state.js";
import { localDayKey } from "./quiet-hours.js";

/** Why a tick did not sweep. Each one is written to the tick's history row. */
export type HeartbeatSweepSkip = "disabled" | "quiet_hours" | "interval" | "budget";

/** Who asked: the loop's own tick, or `trent heartbeat sweep --now`. */
export type HeartbeatSweepTrigger = "heartbeat" | "manual";

export interface HeartbeatSweepRequest {
  readonly at: string;
  /** The hard cap on this sweep, integer cents (`improve.sweep_cap_cents`). */
  readonly capCents: number;
  readonly trigger: HeartbeatSweepTrigger;
}

/** One metered sweep. The CLI binds `runImprovementSweep` on the profile's improve store. */
export type HeartbeatSweepPort = (request: HeartbeatSweepRequest) => Promise<SweepReport>;

export interface HeartbeatSweepDeps {
  readonly runSweep: HeartbeatSweepPort;
  /** `improve.sweep_cap_cents`, integer cents. */
  readonly capCents: number;
  /** The day's ledger. Absent, the sweep's own cap is the only meter and no tick is refused for money. */
  readonly budget?: HeartbeatBudgetPort | undefined;
}

/** What one sweep did, as the heartbeat records and delivers it. Integer cents throughout. */
export interface HeartbeatSweepRecord {
  at: string;
  trigger: HeartbeatSweepTrigger;
  /** Drafts the sweep produced. All of them start in quarantine. */
  drafts: number;
  /** Drafts the executing gate passed; they wait for a human to promote them. */
  awaitingPromotion: number;
  /** Drafts the gate could not measure, so they stay in quarantine. */
  quarantined: number;
  rejected: number;
  costCents: number;
  capCents: number;
  /** True when the meter stopped the sweep at its cap. */
  exhausted: boolean;
  /** Why seats produced nothing, in the sweep's own words. */
  blocked: string[];
  errors: string[];
  /** Set when the record could not be sent; the heartbeat keeps it on disk either way. */
  deliveryError?: string;
}

export type HeartbeatSweepOutcome = { ran: true; record: HeartbeatSweepRecord } | { ran: false; skipped: HeartbeatSweepSkip };

const HOUR_MS = 3_600_000;
const CENTS_PER_UNIT = 100;
/** How many blocked reasons a row keeps; the rest are in `trent improve status`. */
const MAX_BLOCKED = 10;

export interface SweepDecisionInput {
  readonly now: Date;
  readonly quiet: boolean;
  /** `heartbeat.enabled` and `heartbeat.sweep.enabled`, with a port actually wired. */
  readonly enabled: boolean;
  readonly intervalHours: number;
  readonly lastSweepAt: string | undefined;
  readonly capCents: number;
  /** What the day's ledger still allows; absent when no ledger is wired. */
  readonly headroomCents: number | undefined;
}

/** The decision, in the order a founder would ask it. `null` means sweep. */
export function decideSweep(input: SweepDecisionInput): HeartbeatSweepSkip | null {
  if (!input.enabled) return "disabled";
  if (input.quiet) return "quiet_hours";
  if (!intervalElapsed(input.lastSweepAt, input.now, input.intervalHours)) return "interval";
  if (input.headroomCents !== undefined && input.headroomCents < input.capCents) return "budget";
  return null;
}

/** True when `hours` have passed since the last sweep, or there has never been one. */
export function intervalElapsed(lastSweepAt: string | undefined, now: Date, hours: number): boolean {
  if (lastSweepAt === undefined) return true;
  const last = new Date(lastSweepAt).getTime();
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= hours * HOUR_MS;
}

/**
 * What this heartbeat has spent today, on the wall clock of `tz`: every tick's model cost plus
 * every sweep's, from its own history. It is the only ledger the unattended loop has — nothing
 * else records what the machine spent while the founder was away.
 */
export function spentTodayCents(rows: ReadonlyArray<{ at: string; costCents?: number; sweep?: { costCents: number } }>, now: Date, tz: string): number {
  const today = localDayKey(now, tz);
  let cents = 0;
  for (const row of rows) {
    const at = new Date(row.at);
    if (Number.isNaN(at.getTime()) || localDayKey(at, tz) !== today) continue;
    cents += Math.trunc(row.costCents ?? 0) + Math.trunc(row.sweep?.costCents ?? 0);
  }
  return cents;
}

/** The newest sweep in the history, whatever tick or command produced it. */
export function lastSweepRecord(rows: ReadonlyArray<{ sweep?: HeartbeatSweepRecord }>): HeartbeatSweepRecord | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const record = rows[i]?.sweep;
    if (record !== undefined) return record;
  }
  return null;
}

/** The report as the heartbeat keeps it: counts, spend, and why seats produced nothing. */
export function summariseSweep(report: SweepReport, request: HeartbeatSweepRequest): HeartbeatSweepRecord {
  let drafts = 0;
  let awaitingPromotion = 0;
  let rejected = 0;
  const blocked: string[] = [];
  for (const agent of report.agents) {
    drafts += agent.skillsDistilled;
    awaitingPromotion += agent.skillsGated;
    rejected += agent.skillsRejected;
    for (const reason of agent.skipped) blocked.push(`${agent.agentId}: ${reason}`);
  }
  for (const specialist of report.skippedSpecialists) blocked.push(`${specialist.agentId}: ${specialist.reason} (${specialist.traces}/${specialist.threshold})`);
  if (report.judgeAdvisory) blocked.push("judge_advisory");
  if (report.budget.exhausted) blocked.push("budget_exhausted");
  return {
    at: request.at,
    trigger: request.trigger,
    drafts,
    awaitingPromotion,
    quarantined: Math.max(0, drafts - awaitingPromotion - rejected),
    rejected,
    costCents: Math.trunc(report.costCents),
    capCents: request.capCents,
    exhausted: report.budget.exhausted,
    blocked: [...new Set(blocked)].slice(0, MAX_BLOCKED),
    errors: [...report.agents.flatMap((agent) => agent.errors), ...report.errors].slice(0, MAX_BLOCKED),
  };
}

/** What the day's ledger still allows, or nothing when no ledger is wired or it caps nothing. */
export function ledgerHeadroomCents(budget: HeartbeatBudgetPort | undefined): number | undefined {
  if (budget === undefined) return undefined;
  const limit = budget.limitCents();
  if (limit <= 0) return undefined;
  return limit - budget.spentCents();
}

/**
 * One sweep through the injected port. A port that throws becomes a record carrying the reason:
 * an unattended sweep must never take the heartbeat down with it.
 */
export async function sweepThroughPort(deps: HeartbeatSweepDeps, request: HeartbeatSweepRequest): Promise<HeartbeatSweepRecord> {
  try {
    return summariseSweep(await deps.runSweep(request), request);
  } catch (error) {
    return {
      ...request,
      drafts: 0,
      awaitingPromotion: 0,
      quarantined: 0,
      rejected: 0,
      costCents: 0,
      exhausted: false,
      blocked: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the owner is sent: the counts, the spend against the cap, and who promotes. */
export function renderSweepRecord(record: HeartbeatSweepRecord): string {
  const lines = [
    `Unattended sweep at ${record.at}: ${plural(record.drafts, "draft", "drafts")}, ${record.awaitingPromotion} gated and awaiting promotion, ${record.quarantined} still quarantined, ${record.rejected} rejected.`,
    `Spend: ${record.costCents} of ${record.capCents} cents${record.exhausted ? ", stopped at the cap" : ""} (${dollars(record.costCents)} of ${dollars(record.capCents)}).`,
  ];
  if (record.blocked.length > 0) lines.push(`Produced nothing: ${record.blocked.join("; ")}.`);
  if (record.errors.length > 0) lines.push(`Errors: ${record.errors.join("; ")}.`);
  lines.push("Nothing was promoted; run trent improve status to read the drafts and trent improve promote <draftId> to take one live.");
  return lines.join("\n");
}

function dollars(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `$${Math.floor(abs / CENTS_PER_UNIT)}.${String(abs % CENTS_PER_UNIT).padStart(2, "0")}`;
}
