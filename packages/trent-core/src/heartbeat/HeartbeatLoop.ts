/**
 * The heartbeat loop: every `interval_minutes`, outside quiet hours, one orchestrated run over
 * `<profile>/HEARTBEAT.md` plus the fleet-state block, with `trigger: "heartbeat"`. The run's
 * consolidated summary is read off the event stream exactly as the cron runner reads it; a
 * summary of exactly `NO_REPLY` is swallowed, anything else goes to `gateway.owner` through the
 * injected `deliver`. Inside quiet hours no model is called, and memory consolidation (T1.4)
 * runs once per local calendar day at the first quiet tick.
 *
 * Every tick leaves one row in `<profile>/heartbeat/runs.jsonl` (capped); the log carries the
 * decision, the duration and the cost, never the checklist or the reply body.
 */
import path from "node:path";
import process from "node:process";
import { NODE_IO, atomicWriteFileSync, type ConfigIO } from "../config/atomic-fs.js";
import type { HeartbeatConfig } from "../config/schema.js";
import { EXIT, TrentError } from "../errors/index.js";
import type { OrcEvent, OrchestrationTrigger } from "../orchestrator/types.js";
import { StructuredLogger } from "../telemetry/logger.js";
import { NO_REPLY, readHeartbeatChecklist } from "./checklist.js";
import { renderFleetState, type HeartbeatBudgetPort } from "./fleet-state.js";
import { isQuiet, localDayKey } from "./quiet-hours.js";
import {
  decideSweep,
  lastSweepRecord,
  ledgerHeadroomCents,
  renderSweepRecord,
  sweepThroughPort,
  type HeartbeatSweepDeps,
  type HeartbeatSweepOutcome,
  type HeartbeatSweepRecord,
  type HeartbeatSweepSkip,
  type HeartbeatSweepTrigger,
} from "./sweep-step.js";

export { DEFAULT_HEARTBEAT_MD, HEARTBEAT_MD, NO_REPLY } from "./checklist.js";

export const HEARTBEAT_HISTORY_LIMIT = 200;
const FILE_MODE = 0o600;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** The sentence that closes every objective; the model's whole contract with the founder. */
export const NO_REPLY_CONTRACT = `If nothing on this checklist needs the founder, answer exactly ${NO_REPLY}.`;

/** `sweep` is the row `trent heartbeat sweep --now` leaves; it is a command, never a tick. */
export type HeartbeatDecision = "quiet" | "no_reply" | "reply" | "failed" | "sweep";

/** One line of `<profile>/heartbeat/runs.jsonl`. */
export interface HeartbeatRunRow {
  at: string;
  decision: HeartbeatDecision;
  /** Length of the delivered reply. */
  chars?: number;
  costCents?: number;
  /** Why a run failed. */
  reason?: string;
  /** Set when a reply could not be sent; the reply itself stays in `text` on disk. */
  deliveryError?: string;
  /** A reply the loop could not deliver, kept so `trent heartbeat runs` can show it. */
  text?: string;
  /** True on the quiet row whose tick ran memory consolidation. */
  consolidated?: boolean;
  /** [D2] the unattended sweep this row's tick ran, or the sweep `--now` asked for. */
  sweep?: HeartbeatSweepRecord;
  /** [D2] why this tick did not sweep. Absent when no sweep port is wired at all. */
  sweepSkipped?: HeartbeatSweepSkip;
}

export interface HeartbeatRunOptions {
  readonly trigger: OrchestrationTrigger;
  readonly signal?: AbortSignal;
}

export interface HeartbeatTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HeartbeatLoopDeps {
  readonly profileDir: string;
  readonly config: HeartbeatConfig;
  /** One orchestrated run in a fresh session; the headless runtime's `run`. */
  readonly run: (objective: string, options: HeartbeatRunOptions) => AsyncIterable<OrcEvent>;
  /** Sends `text` to `owner`; the CLI wires the gateway manager's `send`. */
  readonly deliver: (text: string) => Promise<void>;
  readonly owner?: { platform: string; channelId: string } | undefined;
  /** T1.4's `consolidateMemory`, already bound to the runtime's gateway and store. */
  readonly consolidate?: (() => Promise<unknown>) | undefined;
  /** Extra fleet state the profile files do not carry: the budget. */
  readonly state?: { readonly budget?: HeartbeatBudgetPort | undefined } | undefined;
  /**
   * [D2] the unattended improvement sweep: the port that runs one, its cap in integer cents, and
   * the day's ledger. Absent, the loop never sweeps and no row mentions one.
   */
  readonly sweep?: HeartbeatSweepDeps | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timers?: HeartbeatTimers | undefined;
  readonly io?: Partial<ConfigIO> | undefined;
  readonly historyLimit?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface HeartbeatStatus {
  enabled: boolean;
  intervalMinutes: number;
  activeHours: HeartbeatConfig["active_hours"] | null;
  quietNow: boolean;
  running: boolean;
  last: HeartbeatRunRow | null;
  nextTickAt: string | null;
  /** [D2] the unattended sweep: whether it is on, its cadence, the last one and the next one due. */
  sweep: {
    enabled: boolean;
    intervalHours: number;
    last: HeartbeatSweepRecord | null;
    nextAt: string | null;
  };
}

/** `<profile>/heartbeat/runs.jsonl` — one row per tick, newest last. */
export function heartbeatRunsPath(profileDir: string): string {
  return path.join(profileDir, "heartbeat", "runs.jsonl");
}

/** `<profile>/heartbeat/runner.lock`: the pid of the loop ticking this profile. */
export function heartbeatLockPath(profileDir: string): string {
  return path.join(profileDir, "heartbeat", "runner.lock");
}

export function readHeartbeatRuns(profileDir: string, ioOverride?: Partial<ConfigIO>): HeartbeatRunRow[] {
  const io: ConfigIO = { ...NODE_IO, ...(ioOverride ?? {}) };
  const file = heartbeatRunsPath(profileDir);
  if (!io.existsSync(file)) return [];
  return io
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HeartbeatRunRow);
}

function readLockPid(profileDir: string, io: ConfigIO): number | null {
  const file = heartbeatLockPath(profileDir);
  if (!io.existsSync(file)) return null;
  try {
    const pid = (JSON.parse(io.readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when a live process holds this profile's heartbeat lock. */
export function heartbeatRunnerActive(profileDir: string, ioOverride?: Partial<ConfigIO>): boolean {
  const pid = readLockPid(profileDir, { ...NODE_IO, ...(ioOverride ?? {}) });
  return pid !== null && pidAlive(pid);
}

/** What `trent heartbeat status` shows; the next tick is the last row plus the interval. */
export function heartbeatStatus(profileDir: string, config: HeartbeatConfig, now: Date, ioOverride?: Partial<ConfigIO>): HeartbeatStatus {
  const rows = readHeartbeatRuns(profileDir, ioOverride);
  const last = rows[rows.length - 1] ?? null;
  // A `sweep` row is a command, not a tick: it must not move the next tick.
  const lastTick = rows.filter((row) => row.decision !== "sweep").pop() ?? null;
  const lastSweep = lastSweepRecord(rows);
  return {
    enabled: config.enabled,
    intervalMinutes: config.interval_minutes,
    activeHours: config.active_hours ?? null,
    quietNow: isQuiet(now, config.active_hours),
    running: heartbeatRunnerActive(profileDir, ioOverride),
    last,
    nextTickAt: lastTick === null ? null : new Date(new Date(lastTick.at).getTime() + config.interval_minutes * MINUTE_MS).toISOString(),
    sweep: {
      enabled: config.sweep.enabled,
      intervalHours: config.sweep_interval_hours,
      last: lastSweep,
      nextAt: lastSweep === null ? null : new Date(new Date(lastSweep.at).getTime() + config.sweep_interval_hours * HOUR_MS).toISOString(),
    },
  };
}

interface Folded {
  summary: string | null;
  failed: boolean;
  reason: string | undefined;
  costCents: number;
}

function fold(current: Folded, event: OrcEvent): Folded {
  const next = { ...current };
  if (event.kind === "step_end" && typeof event.step?.costCents === "number") next.costCents += event.step.costCents;
  switch (event.kind) {
    case "consolidate_end":
    case "run_done": {
      const summary = event.run?.summary;
      if (summary !== undefined && summary !== "") next.summary = summary;
      return next;
    }
    case "run_failed":
      next.failed = true;
      next.reason = event.detail !== undefined && event.detail !== "" ? event.detail : event.run?.summary;
      return next;
    default:
      return next;
  }
}

export class HeartbeatLoop {
  private readonly deps: HeartbeatLoopDeps;
  private readonly io: ConfigIO;
  private readonly logger: StructuredLogger;
  private readonly historyLimit: number;
  private readonly timers: HeartbeatTimers;
  private timer: unknown;
  private ticking: Promise<HeartbeatRunRow> | undefined;
  private lastConsolidatedDay: string | undefined;
  private tickHook: (() => Promise<unknown>) | undefined; // [P3] the auto reviewer's pass

  constructor(deps: HeartbeatLoopDeps) {
    this.deps = deps;
    this.io = { ...NODE_IO, ...(deps.io ?? {}) };
    this.historyLimit = deps.historyLimit ?? HEARTBEAT_HISTORY_LIMIT;
    this.timers = deps.timers ?? { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
    this.logger = new StructuredLogger({ runId: "heartbeat", stage: "heartbeat.loop", ...(deps.log === undefined ? {} : { sink: deps.log }) });
    const tz = deps.config.active_hours?.tz ?? "UTC";
    const rows = readHeartbeatRuns(deps.profileDir, deps.io);
    const consolidated = rows.filter((row) => row.consolidated === true).pop();
    if (consolidated !== undefined) this.lastConsolidatedDay = localDayKey(new Date(consolidated.at), tz);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  public get intervalMs(): number {
    return this.deps.config.interval_minutes * MINUTE_MS;
  }

  /** The objective for a tick: the checklist, the fleet-state block and the contract sentence. */
  public objective(): string {
    const rows = readHeartbeatRuns(this.deps.profileDir, this.deps.io);
    const last = rows[rows.length - 1];
    const state = renderFleetState({
      profileDir: this.deps.profileDir,
      budget: this.deps.state?.budget,
      lastHeartbeat: last === undefined ? undefined : { at: last.at, decision: last.decision },
    });
    return `${readHeartbeatChecklist(this.deps.profileDir, this.deps.io).trimEnd()}\n\n${state}\n\n${NO_REPLY_CONTRACT}\n`;
  }

  /** One heartbeat. Overlapping ticks share the in-flight one, so a slow run never doubles up. */
  public tick(): Promise<HeartbeatRunRow> {
    this.ticking ??= this.tickOnce().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /**
   * [P3] Runs `hook` at the start of every tick, quiet or not: the surface that opened the loop hands
   * it the auto reviewer's pass (`governance/auto-review.ts`). A failure is logged, never the tick's.
   */
  public beforeEachTick(hook: (() => Promise<unknown>) | undefined): void {
    this.tickHook = hook;
  }

  private async tickOnce(): Promise<HeartbeatRunRow> {
    try {
      await this.tickHook?.(); // [P3]
    } catch (error) {
      this.logger.error("heartbeat.tick_hook.failed", { reason: error instanceof Error ? error.message : String(error) });
    }
    const startedAt = this.now();
    const quiet = isQuiet(startedAt, this.deps.config.active_hours);
    const consolidated = await this.maybeConsolidate(startedAt, quiet);
    // [D2] the sweep is decided before the turn, so a quiet tick still says why it did not sweep.
    const swept = await this.maybeSweep(startedAt, quiet);
    if (quiet) {
      const row: HeartbeatRunRow = { at: startedAt.toISOString(), decision: "quiet", ...(consolidated ? { consolidated: true } : {}), ...swept };
      this.appendHistory(row);
      this.logger.info("heartbeat.tick.quiet", { consolidated });
      return row;
    }
    const row = { ...(await this.runTurn(startedAt)), ...swept };
    if (consolidated) row.consolidated = true;
    this.appendHistory(row);
    return row;
  }

  /**
   * [D2] At most one sweep every `sweep_interval_hours`, only while the founder has opted in, only
   * outside quiet hours, and only while the day's ledger still holds the cap. What happened is
   * returned as the fields the tick's row carries, so a skip is as visible as a run.
   */
  private async maybeSweep(now: Date, quiet: boolean): Promise<{ sweep?: HeartbeatSweepRecord; sweepSkipped?: HeartbeatSweepSkip }> {
    const deps = this.deps.sweep;
    if (deps === undefined) return {};
    const { config } = this.deps;
    const skip = decideSweep({
      now,
      quiet,
      enabled: config.enabled && config.sweep.enabled,
      intervalHours: config.sweep_interval_hours,
      lastSweepAt: lastSweepRecord(readHeartbeatRuns(this.deps.profileDir, this.deps.io))?.at,
      capCents: deps.capCents,
      headroomCents: ledgerHeadroomCents(deps.budget),
    });
    if (skip !== null) {
      this.logger.info("heartbeat.sweep.skipped", { reason: skip });
      return { sweepSkipped: skip };
    }
    const record = await this.runSweep(now, "heartbeat");
    const deliveryError = await this.deliverSweep(record);
    if (deliveryError !== undefined) record.deliveryError = deliveryError;
    return { sweep: record };
  }

  /** One metered sweep through the injected port, logged by what it made and what it cost. */
  private async runSweep(now: Date, trigger: HeartbeatSweepTrigger): Promise<HeartbeatSweepRecord> {
    const deps = this.deps.sweep;
    if (deps === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.sweep", message: "no sweep port is wired to this heartbeat loop" });
    const record = await sweepThroughPort(deps, { at: now.toISOString(), capCents: deps.capCents, trigger });
    this.logger.log(record.errors.length > 0 ? "error" : "info", "heartbeat.sweep.done", {
      trigger,
      drafts: record.drafts,
      awaitingPromotion: record.awaitingPromotion,
      costCents: record.costCents,
      capCents: record.capCents,
      exhausted: record.exhausted,
    });
    return record;
  }

  /** The sweep's report down the same gateway path a reply takes; the error, if any, is the row's. */
  private async deliverSweep(record: HeartbeatSweepRecord): Promise<string | undefined> {
    if (this.deps.owner === undefined) return "gateway.owner is not configured; set gateway.owner { platform, channelId } in config.yaml";
    try {
      await this.deps.deliver(renderSweepRecord(record));
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * [D2] `trent heartbeat sweep --now`: one sweep whatever the interval and the opt-in say, still
   * capped, and still refused when the day's ledger cannot cover the cap. The founder is at the
   * terminal, so the record is returned rather than messaged, and it lands in the history as its
   * own `sweep` row.
   */
  public async sweepNow(): Promise<HeartbeatSweepOutcome> {
    const deps = this.deps.sweep;
    if (deps === undefined) return { ran: false, skipped: "disabled" };
    const at = this.now();
    const headroom = ledgerHeadroomCents(deps.budget);
    if (headroom !== undefined && headroom < deps.capCents) {
      this.logger.info("heartbeat.sweep.skipped", { reason: "budget", trigger: "manual" });
      return { ran: false, skipped: "budget" };
    }
    const record = await this.runSweep(at, "manual");
    this.appendHistory({ at: record.at, decision: "sweep", sweep: record });
    return { ran: true, record };
  }

  private async runTurn(startedAt: Date): Promise<HeartbeatRunRow> {
    this.logger.info("heartbeat.run.start", {});
    let folded: Folded = { summary: null, failed: false, reason: undefined, costCents: 0 };
    let threw: string | undefined;
    try {
      for await (const event of this.deps.run(this.objective(), { trigger: "heartbeat" })) folded = fold(folded, event);
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    const at = startedAt.toISOString();
    const cost = folded.costCents > 0 ? { costCents: folded.costCents } : {};
    let row: HeartbeatRunRow;
    if (folded.failed || threw !== undefined) {
      row = { at, decision: "failed", reason: threw ?? folded.reason ?? "run failed without a reason", ...cost };
    } else {
      const text = (folded.summary ?? "").trim();
      if (text === "" || text === NO_REPLY) row = { at, decision: "no_reply", ...cost };
      else row = await this.deliverReply(at, text, cost);
    }
    this.logger.log(row.decision === "failed" ? "error" : "info", "heartbeat.run.end", {
      decision: row.decision,
      durationMs: this.now().getTime() - startedAt.getTime(),
      costCents: folded.costCents,
      delivered: row.decision === "reply" && row.deliveryError === undefined,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.deliveryError === undefined ? {} : { deliveryError: row.deliveryError }),
    });
    return row;
  }

  private async deliverReply(at: string, text: string, cost: { costCents?: number }): Promise<HeartbeatRunRow> {
    const row: HeartbeatRunRow = { at, decision: "reply", chars: text.length, ...cost };
    if (this.deps.owner === undefined) {
      row.deliveryError = "gateway.owner is not configured; set gateway.owner { platform, channelId } in config.yaml";
      row.text = text;
      return row;
    }
    try {
      await this.deps.deliver(text);
    } catch (error) {
      row.deliveryError = error instanceof Error ? error.message : String(error);
      row.text = text;
    }
    return row;
  }

  /** Once per local day: at the first quiet tick, or at the first tick of the day when no window is set. */
  private async maybeConsolidate(now: Date, quiet: boolean): Promise<boolean> {
    const { config, consolidate } = this.deps;
    if (!config.consolidate_memory || consolidate === undefined) return false;
    if (config.active_hours !== undefined && !quiet) return false;
    const day = localDayKey(now, config.active_hours?.tz ?? "UTC");
    if (day === this.lastConsolidatedDay) return false;
    this.lastConsolidatedDay = day;
    try {
      await consolidate();
      this.logger.info("heartbeat.consolidate.done", { day });
      return true;
    } catch (error) {
      this.logger.error("heartbeat.consolidate.failed", { day, reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private appendHistory(row: HeartbeatRunRow): void {
    const file = heartbeatRunsPath(this.deps.profileDir);
    if (!this.io.existsSync(path.dirname(file))) this.io.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [...readHeartbeatRuns(this.deps.profileDir, this.deps.io), row].slice(-this.historyLimit);
    atomicWriteFileSync(this.io, file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, FILE_MODE);
  }

  /** Takes the profile's heartbeat lock and ticks every `interval_minutes`. Refuses when another live loop holds it. */
  public start(): void {
    if (this.timer !== undefined) return;
    const holder = readLockPid(this.deps.profileDir, this.io);
    if (holder !== null && pidAlive(holder)) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "heartbeat.start",
        message: `a heartbeat loop is already running for this profile (pid ${holder}); stop it before starting another`,
        target: heartbeatLockPath(this.deps.profileDir),
      });
    }
    const file = heartbeatLockPath(this.deps.profileDir);
    if (!this.io.existsSync(path.dirname(file))) this.io.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(this.io, file, `${JSON.stringify({ pid: process.pid, started_at: this.now().toISOString() })}\n`, FILE_MODE);
    this.timer = this.timers.setInterval(() => {
      this.tick().catch((error: unknown) => {
        this.logger.error("heartbeat.tick.failed", { reason: error instanceof Error ? error.message : String(error) });
      });
    }, this.intervalMs);
    this.logger.info("heartbeat.loop.started", { pid: process.pid, intervalMs: this.intervalMs });
  }

  /** Stops ticking and releases the lock. Idempotent. */
  public stop(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
    const file = heartbeatLockPath(this.deps.profileDir);
    if (readLockPid(this.deps.profileDir, this.io) === process.pid && this.io.existsSync(file)) this.io.unlinkSync(file);
    this.logger.info("heartbeat.loop.stopped", { pid: process.pid });
  }

  public get running(): boolean {
    return this.timer !== undefined;
  }
}
