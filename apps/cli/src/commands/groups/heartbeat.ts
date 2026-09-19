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
import { HeartbeatLoop, heartbeatStatus, readHeartbeatRuns, type HeartbeatRunRow, type HeartbeatStatus } from "@trent/core/heartbeat/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import type { ReplConfig } from "../../repl/types.js";
import { fallbackImproveStore } from "../improve.js";
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

function runLine(row: HeartbeatRunRow, ctx: CommandContext): string {
  const decision = row.decision === "failed" ? ctx.theme.error(row.decision.padEnd(8, " ")) : ctx.theme.success(row.decision.padEnd(8, " "));
  const extras = [
    row.chars !== undefined ? `${row.chars} chars` : "",
    row.costCents !== undefined ? `${row.costCents}c` : "",
    row.consolidated === true ? "memory consolidated" : "",
    row.reason !== undefined ? `reason: ${row.reason}` : "",
    row.deliveryError !== undefined ? `delivery failed: ${row.deliveryError}` : "",
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
