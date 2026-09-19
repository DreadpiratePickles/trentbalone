/**
 * The `heartbeat` group: `trent heartbeat start [--once] | status | runs [--last N]` over the
 * loop in `@trent/core/heartbeat`. `start` builds the same headless runtime the REPL, the
 * gateway and the cron runner run on, and a reply that is not `NO_REPLY` goes to `gateway.owner`
 * through the gateway manager's `send`; the manager is built on first delivery only. Memory
 * consolidation (T1.4) is wired here to the runtime's store and the configured provider, so the
 * loop calls it once a day inside quiet hours without knowing how it is built.
 */
import process from "node:process";
import type { ConfigManager, TrentConfig } from "@trent/core";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
import {
  HeartbeatLoop,
  heartbeatStatus,
  readHeartbeatRuns,
  spentTodayCents,
  type HeartbeatRunRow,
  type HeartbeatStatus,
  type HeartbeatSweepDeps,
  type HeartbeatSweepRecord,
} from "@trent/core/heartbeat/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import type { ReplConfig } from "../../repl/types.js";
import { fallbackImproveStore } from "../improve.js";
import { buildMeteredSweep } from "../improve-sweep.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal, type SignalTarget } from "../../signals.js";

export const HEARTBEAT_SUBJECT = "Trent heartbeat";

/** What `start` needs from the caller: a runtime and a way to build the manager lazily. */
export interface HeartbeatWiring {
  readonly configManager: ConfigManager;
  readonly config: TrentConfig;
  readonly runtime: HeadlessRuntime;
  readonly buildManager: (configManager: ConfigManager, options: Record<string, never>) => GatewayManager;
  readonly now?: (() => Date) | undefined;
  readonly log: (line: string) => void;
}

/** `store.improve()` when the runtime's store has one; the structural store type may not. */
function improveOf(store: unknown): ImproveStorePort | undefined {
  const candidate = store as { improve?: () => ImproveStorePort } | null | undefined;
  return typeof candidate?.improve === "function" ? candidate.improve() : undefined;
}

/**
 * [D2] The unattended sweep this profile may run, and [D2.1] the ONE builder it shares with
 * `trent improve sweep`: `buildMeteredSweep` wires the profile's improve store, the frozen
 * surface, pass^k, the holdout and — the part D2 could not reach — the seat suites, so a seat
 * whose golden a human promoted is gated here exactly as it is at the command line, and a seat
 * with none is refused by name instead of a bare `no_suite`.
 *
 * `live: false` is the offline rule (`skipLLM`, no `actuals`, no `judge`): a sweep nobody is
 * watching never reflects through a model, so its meter reports a real zero and
 * `trent improve sweep --live` stays the only path that spends. The cap it is handed is
 * `improve.sweep_cap_cents`; the day's ledger is what this heartbeat has already written to its
 * own history today, against `budget.daily_cap`. Every draft it produces is in quarantine:
 * `trent improve promote` is still the only way one reaches a seat.
 */
function sweepWiring(wiring: HeartbeatWiring): HeartbeatSweepDeps {
  const { configManager, config } = wiring;
  const profileDir = configManager.getProfileDir();
  const tz = config.heartbeat.active_hours?.tz ?? "UTC";
  return {
    capCents: config.improve.sweep_cap_cents,
    budget: {
      limitCents: () => config.budget.daily_cap,
      spentCents: () => spentTodayCents(readHeartbeatRuns(profileDir), (wiring.now ?? (() => new Date()))(), tz),
    },
    runSweep: (request) => buildMeteredSweep({ config: () => configManager }, { live: false, budgetCents: request.capCents }),
  };
}

/**
 * The loop over this profile. The gateway manager and the model gateway for consolidation are
 * both built on first use: a heartbeat that answers `NO_REPLY` all day never touches either.
 */
export function openHeartbeat(wiring: HeartbeatWiring): { loop: HeartbeatLoop; close: () => Promise<void> } {
  const { configManager, config, runtime } = wiring;
  const owner = config.gateway.owner;
  let manager: GatewayManager | undefined;
  const loop = new HeartbeatLoop({
    profileDir: configManager.getProfileDir(),
    config: config.heartbeat,
    owner,
    // [D2] the sweep port is always wired: the loop's own gates decide whether it ever runs, and
    // `trent heartbeat sweep --now` needs it even while the scheduled sweep is off.
    sweep: sweepWiring(wiring),
    now: wiring.now,
    log: wiring.log,
    run: (objective, options) => runtime.run(objective, options),
    deliver: async (text) => {
      if (owner === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.deliver", message: "gateway.owner is not configured" });
      manager ??= wiring.buildManager(configManager, {});
      const receipt = await manager.send(owner.platform, { channelId: owner.channelId, text, metadata: { subject: HEARTBEAT_SUBJECT } });
      if (!receipt.sent) {
        throw new TrentError({ code: EXIT.PROVIDER, operation: "heartbeat.deliver", message: `queued as ${receipt.queued} but not sent; the gateway will retry when ${owner.platform} is reachable`, target: `${owner.platform}:${owner.channelId}` });
      }
    },
    consolidate: async () => {
      configManager.loadSecrets();
      const [{ createModelGateway }, { consolidateMemory }] = await Promise.all([import("@trent/core/model-gateway/index.js"), import("@trent/core/fleet-memory/index.js")]);
      const gateway = await createModelGateway({ preferredProvider: config.provider as ModelProvider, models: { executor: config.model } });
      // [C4] Every configured block, not only MEMORY.md and USER.md. A read_only block is left
      // alone unless `memory.consolidation_may_edit` names it, and no one pass may take out more
      // than `memory.consolidation_max_removal_ratio` of a block's entries.
      return consolidateMemory({
        profileDir: configManager.getProfileDir(),
        companyId: runtime.companyId,
        gateway,
        store: improveOf(runtime.store) ?? fallbackImproveStore(),
        blocks: config.memory.blocks,
        mayEdit: config.memory.consolidation_may_edit,
        maxRemovalRatio: config.memory.consolidation_max_removal_ratio,
      });
    },
  });
  return {
    loop,
    close: async () => {
      loop.stop();
      await manager?.stopAll();
    },
  };
}

function ownerLabel(config: TrentConfig): string | null {
  return config.gateway.owner === undefined ? null : `${config.gateway.owner.platform}:${config.gateway.owner.channelId}`;
}

function requireEnabled(config: TrentConfig): void {
  if (!config.heartbeat.enabled) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.start", message: "the heartbeat is off; set heartbeat.enabled: true in config.yaml (trent config set heartbeat.enabled true)" });
  }
}

/**
 * The same exit discipline as `trent cron start`: Ctrl+C, SIGTERM and SIGHUP all release the lock,
 * the manager and the runtime before the process goes. The claim is what makes Ctrl+C behave like
 * the other two — without it the binary's global handler exits on top of the release
 * (`../../signals.ts`). The `exit` hook stays as the last resort that still drops the pid lock.
 */
function releaseOnExit(close: () => Promise<void>, stopSync: () => void, signals?: SignalTarget): void {
  releaseOnSignal(close, signals);
  (signals ?? process).once("exit", stopSync);
}

/** [D2] one sweep in one clause: what it made, what waits for a human, what it cost of its cap. */
function sweepExtra(record: HeartbeatSweepRecord): string {
  return `sweep: ${record.drafts} drafts, ${record.awaitingPromotion} awaiting promotion, ${record.costCents} of ${record.capCents} cents`;
}

function runLine(row: HeartbeatRunRow, ctx: CommandContext): string {
  const decision = row.decision === "failed" ? ctx.theme.error(row.decision.padEnd(8, " ")) : ctx.theme.success(row.decision.padEnd(8, " "));
  const extras = [
    row.chars !== undefined ? `${row.chars} chars` : "",
    row.costCents !== undefined ? `${row.costCents}c` : "",
    row.consolidated === true ? "memory consolidated" : "",
    row.reason !== undefined ? `reason: ${row.reason}` : "",
    row.deliveryError !== undefined ? `delivery failed: ${row.deliveryError}` : "",
    // [D2] a sweep that ran, and a skip the founder can act on. "disabled" is the shipped state,
    // so it is not repeated on every row; `heartbeat status` names it once.
    row.sweep === undefined ? "" : sweepExtra(row.sweep),
    row.sweepSkipped !== undefined && row.sweepSkipped !== "disabled" ? `sweep skipped: ${row.sweepSkipped}` : "",
  ].filter((s) => s !== "");
  return `  ${decision} ${ctx.theme.value(row.at)}${extras.length > 0 ? ` ${ctx.theme.meta(extras.join(", "))}` : ""}`;
}

export const heartbeatSpec: CommandSpec = {
  name: "heartbeat",
  description: "The periodic check over <profile>/HEARTBEAT.md that messages the owner only when something needs them",
  subcommands: [
    {
      name: "start",
      description: "Run the heartbeat loop on the headless runtime every heartbeat.interval_minutes, outside active_hours it stays quiet",
      options: [{ flags: "--once", description: "Tick once and exit (for an external scheduler such as launchd or system cron)" }],
      async run(ctx, opts) {
        const configManager = ctx.config();
        const config = configManager.loadConfig();
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "heartbeat start", enabled: config.heartbeat.enabled, intervalMinutes: config.heartbeat.interval_minutes, owner: ownerLabel(config) } };
        }
        requireEnabled(config);
        const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config: config as unknown as ReplConfig });
        const { loop, close } = openHeartbeat({
          configManager,
          config,
          runtime,
          buildManager: ctx.overrides.gatewayManager ?? ((cm, options) => new GatewayManager(cm, options)),
          now: ctx.overrides.now,
          log: (line) => ctx.err(line),
        });
        const shutdown = async (): Promise<void> => {
          await close();
          await runtime.cleanup();
        };
        if (opts.once === true) {
          try {
            return { data: { once: true, run: await loop.tick() } };
          } finally {
            await shutdown();
          }
        }
        try {
          loop.start();
        } catch (error) {
          await shutdown();
          throw error;
        }
        releaseOnExit(shutdown, () => loop.stop(), ctx.overrides.signals);
        return { data: { started: true, pid: process.pid, intervalMinutes: config.heartbeat.interval_minutes, owner: ownerLabel(config) }, keepAlive: true };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; enabled?: boolean; once?: boolean; run?: HeartbeatRunRow; started?: boolean; intervalMinutes?: number; owner?: string | null };
        if (d.dryRun === true) {
          return [`  ${ctx.theme.meta(d.enabled === true ? "would start the heartbeat every" : "heartbeat.enabled is false; would refuse; interval")} ${ctx.theme.value(`${String(d.intervalMinutes)} min`)}`];
        }
        if (d.once === true && d.run !== undefined) return [runLine(d.run, ctx)];
        return [
          `  ${ctx.theme.success("heartbeat started")} ${ctx.theme.meta(`pid ${process.pid}, every ${String(d.intervalMinutes)} min, replies to ${d.owner ?? "nobody (set gateway.owner)"}`)}`,
          ctx.theme.meta("  Ctrl+C stops it; history is under <profile>/heartbeat/runs.jsonl"),
        ];
      },
    },
    {
      name: "status",
      description: "Whether the heartbeat is enabled, its interval and window, the last decision and the next tick",
      run(ctx) {
        const configManager = ctx.config();
        const config = configManager.loadConfig();
        const status = heartbeatStatus(configManager.getProfileDir(), config.heartbeat, (ctx.overrides.now ?? (() => new Date()))());
        return { data: { ...status, owner: ownerLabel(config) } as unknown as Record<string, unknown> };
      },
      render(data, ctx) {
        const d = data as unknown as HeartbeatStatus & { owner: string | null };
        const hours = d.activeHours ?? null;
        const window = hours === null ? "always" : `${hours.start}-${hours.end} ${hours.tz}`;
        const lines = [
          ctx.theme.emphasis("HEARTBEAT"),
          `  ${ctx.theme.meta("enabled ")} ${d.enabled ? ctx.theme.success("yes") : ctx.theme.meta("no")}${d.running ? ctx.theme.meta(" (loop running)") : ""}`,
          `  ${ctx.theme.meta("interval")} ${ctx.theme.value(`${d.intervalMinutes} min`)}`,
          `  ${ctx.theme.meta("active  ")} ${ctx.theme.value(window)}${d.quietNow ? ctx.theme.meta(" (quiet now)") : ""}`,
          `  ${ctx.theme.meta("owner   ")} ${ctx.theme.value(d.owner ?? "not set")}`,
        ];
        if (d.last === null) lines.push(ctx.theme.meta("  no heartbeat yet; trent heartbeat start --once runs one now"));
        else {
          lines.push(`  ${ctx.theme.meta("last    ")} ${ctx.theme.value(d.last.at)} ${ctx.theme.body(d.last.decision)}`);
          lines.push(`  ${ctx.theme.meta("next    ")} ${ctx.theme.value(d.nextTickAt ?? "")}`);
        }
        // [D2] the unattended sweep: whether it is on, when the last one ran, what it cost and made.
        const sweepState = d.sweep.enabled ? ctx.theme.success(`every ${d.sweep.intervalHours} h`) : ctx.theme.meta(`off (heartbeat.sweep.enabled, every ${d.sweep.intervalHours} h when on)`);
        lines.push(`  ${ctx.theme.meta("sweep   ")} ${sweepState}`);
        const sweep = d.sweep.last;
        if (sweep === null) lines.push(ctx.theme.meta("  no sweep yet; trent heartbeat sweep --now runs one"));
        else {
          lines.push(`  ${ctx.theme.meta("  last  ")} ${ctx.theme.value(sweep.at)} ${ctx.theme.body(sweep.trigger)} ${ctx.theme.meta(sweepExtra(sweep))}`);
          if (d.sweep.nextAt !== null && d.sweep.enabled) lines.push(`  ${ctx.theme.meta("  next  ")} ${ctx.theme.value(d.sweep.nextAt)}`);
        }
        return lines;
      },
    },
    {
      // [D2] the unattended sweep, on demand. The scheduled one runs from the loop; this is the
      // same port, the same cap and the same ledger, with the interval and the opt-in bypassed.
      name: "sweep",
      description: "Run one metered improvement sweep now, capped at improve.sweep_cap_cents; drafts stay in quarantine for trent improve promote",
      options: [{ flags: "--now", description: "Sweep immediately, whatever heartbeat.sweep_interval_hours and heartbeat.sweep.enabled say" }],
      async run(ctx, opts) {
        const configManager = ctx.config();
        const config = configManager.loadConfig();
        const capCents = config.improve.sweep_cap_cents;
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "heartbeat sweep", capCents, intervalHours: config.heartbeat.sweep_interval_hours, scheduled: config.heartbeat.sweep.enabled } };
        }
        if (opts.now !== true) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "heartbeat.sweep",
            message: "pass --now to sweep from here; the unattended one runs from the loop (trent config set heartbeat.sweep.enabled true)",
          });
        }
        const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config: config as unknown as ReplConfig });
        const { loop, close } = openHeartbeat({
          configManager,
          config,
          runtime,
          buildManager: ctx.overrides.gatewayManager ?? ((cm, options) => new GatewayManager(cm, options)),
          now: ctx.overrides.now,
          log: (line) => ctx.err(line),
        });
        try {
          return { data: { ...(await loop.sweepNow()), capCents } as unknown as Record<string, unknown> };
        } finally {
          await close();
          await runtime.cleanup();
        }
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; capCents?: number; intervalHours?: number; ran?: boolean; skipped?: string; record?: HeartbeatSweepRecord };
        if (d.dryRun === true) {
          return [`  ${ctx.theme.meta("would sweep now, capped at")} ${ctx.theme.value(`${String(d.capCents)} cents`)} ${ctx.theme.meta(`(unattended: every ${String(d.intervalHours)} hours)`)}`];
        }
        if (d.ran !== true || d.record === undefined) {
          return [`  ${ctx.theme.needsApproval(`no sweep: ${d.skipped ?? ""}`)} ${ctx.theme.meta(`the day's ledger cannot cover ${String(d.capCents)} cents; raise budget.daily_cap or wait for tomorrow`)}`];
        }
        const r = d.record;
        const lines = [
          `  ${ctx.theme.emphasis("SWEEP")} ${ctx.theme.value(r.at)}`,
          `  ${ctx.theme.meta("drafts  ")} ${ctx.theme.value(String(r.drafts))} ${ctx.theme.meta(`(${r.awaitingPromotion} awaiting promotion, ${r.quarantined} quarantined, ${r.rejected} rejected)`)}`,
          `  ${ctx.theme.meta("spend   ")} ${ctx.theme.value(`${r.costCents} of ${r.capCents} cents`)}${r.exhausted ? ctx.theme.needsApproval(" (stopped at the cap)") : ""}`,
        ];
        for (const reason of r.blocked) lines.push(`  ${ctx.theme.meta("blocked ")} ${ctx.theme.body(reason)}`);
        for (const error of r.errors) lines.push(`  ${ctx.theme.error("error   ")} ${ctx.theme.body(error)}`);
        lines.push(ctx.theme.meta("  nothing was promoted; trent improve status reads the drafts, trent improve promote <draftId> takes one live"));
        return lines;
      },
    },
    {
      name: "runs",
      description: "Show the heartbeat history from <profile>/heartbeat/runs.jsonl",
      options: [{ flags: "--last <n>", description: "Only the newest N rows", defaultValue: "50" }],
      run(ctx, opts) {
        const last = Number.parseInt(String(opts.last ?? "50"), 10);
        if (!Number.isInteger(last) || last < 1) {
          throw new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.runs", message: "--last must be a positive integer", target: String(opts.last) });
        }
        if (ctx.dryRun) return { data: { dryRun: true, command: "heartbeat runs", last } };
        const rows = readHeartbeatRuns(ctx.config().getProfileDir());
        return { data: { runs: rows.slice(Math.max(0, rows.length - last)) } };
      },
      render(data, ctx) {
        const d = data as { runs?: HeartbeatRunRow[]; dryRun?: boolean };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would list the heartbeat history")}`];
        const rows = d.runs ?? [];
        const lines = [ctx.theme.emphasis(`HEARTBEAT RUNS (${rows.length})`)];
        for (const row of rows) lines.push(runLine(row, ctx));
        if (rows.length === 0) lines.push(ctx.theme.meta("  none yet; trent heartbeat start --once runs one now"));
        return lines;
      },
    },
  ],
};
