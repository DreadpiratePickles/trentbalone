/**
 * `trent service daemon`: the messaging gateway (when `gateway.enabled`), the cron runner and the
 * heartbeat loop (when `heartbeat.enabled`) in ONE foreground process, which is what the launchd
 * agent and the systemd unit written by `trent service install` run (`./service.ts`).
 *
 * One headless runtime serves all three, the way `trent gateway start` already carries the
 * heartbeat (`./servers.ts`): gateway chat runs are charged as `gateway`, and cron and the
 * heartbeat name themselves per run (G3.1). One gateway manager serves the listeners, cron's
 * deliveries and alerts, and the heartbeat's replies; with the gateway off, a manager is built on
 * the first delivery only, as `cron start` and `heartbeat start` do.
 *
 * Locks, exactly once each: the gateway manager takes `locks/gateway.lock` and the runner and the
 * loop their own pid files, and this process is ONE writer on the profile (`locks/writers/<pid>`,
 * labels reference-counted) with the extra label `service`, by which `trent service status` finds
 * the daemon whether or not the gateway is on. A live holder of any of them is refused before a
 * runtime is built. SIGTERM, SIGINT and SIGHUP stop the heartbeat, the runner and the gateway in
 * that order, then the runtime, then the writer registration, and the process exits 130
 * (`../../signals.ts`). A component that cannot start stops the ones already started and the
 * command exits non-zero (`@trent/core/service` `ServiceSupervisor`).
 *
 * The cron wiring mirrors `openRunner` in `./cron.ts` (deliver, the incident alert, the social
 * publish handler, the [P1-D] refusal of a pinned model), which is not exported; the two must be
 * kept in step until it is.
 */
import process from "node:process";
import type { TrentConfig } from "@trent/core";
import { CronRunner, cronRunnerActive, cronRunnerLockPath, readCronRunnerLock, type CronRunOptions } from "@trent/core/cron/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { GatewayManager, linkRunApprovals, type RunApprovalLink } from "@trent/core/gateway/index.js";
import { heartbeatLockPath, heartbeatRunnerActive, type HeartbeatLoop } from "@trent/core/heartbeat/index.js";
import { acquireProfileWriter, gatewayRunningError, liveGatewayHolder, profileLockPath } from "@trent/core/profile/locks.js";
import { ServiceLog, ServiceSupervisor, serviceLogPaths, type ServiceComponentReport, type ServiceEntry } from "@trent/core/service/index.js";
import { SOCIAL_PUBLISH_HANDLER, createSocialPublishHandler } from "@trent/core/tools/social/index.js";
import type { CommandOutcome } from "../registry.js";
import type { CommandContext } from "../context.js";
import { createAgentHandler } from "../../gateway/agent-handler.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal } from "../../signals.js";
import { openHeartbeat } from "./heartbeat.js";

type BuildManager = NonNullable<CommandContext["overrides"]["gatewayManager"]>;

export interface DaemonPlanEntry {
  readonly name: string;
  readonly state: "would-start" | "skipped";
  readonly detail?: string;
}

/** What the daemon would run on this config, in start order. */
export function daemonPlan(config: TrentConfig): DaemonPlanEntry[] {
  return [
    config.gateway.enabled ? { name: "gateway", state: "would-start" } : { name: "gateway", state: "skipped", detail: "gateway.enabled is false" },
    { name: "cron", state: "would-start" },
    config.heartbeat.enabled ? { name: "heartbeat", state: "would-start" } : { name: "heartbeat", state: "skipped", detail: "heartbeat.enabled is false" },
  ];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Refuses before anything is built when a live process already runs a part of this profile. */
function refuseLiveHolders(profileDir: string, config: TrentConfig): void {
  if (config.gateway.enabled) {
    const holder = liveGatewayHolder(profileDir);
    if (holder !== null) throw gatewayRunningError("service.daemon", holder, profileLockPath(profileDir, "gateway"));
  }
  const cron = readCronRunnerLock(profileDir);
  if (cron !== null && cronRunnerActive(profileDir)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "service.daemon", message: `a cron runner is already running for this profile (pid ${cron.pid}); stop it before starting the service`, target: cronRunnerLockPath(profileDir) });
  }
  if (config.heartbeat.enabled && heartbeatRunnerActive(profileDir)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "service.daemon", message: "a heartbeat loop is already running for this profile; stop it before starting the service", target: heartbeatLockPath(profileDir) });
  }
}

/** `platform:channel`, split at the first colon, exactly as `./cron.ts` reads a job's deliver target. */
function parseDeliverTarget(target: string): { platform: string; channelId: string } {
  const colon = target.indexOf(":");
  const platform = colon > 0 ? target.slice(0, colon).trim().toLowerCase() : "";
  const channelId = colon > 0 ? target.slice(colon + 1).trim() : "";
  if (platform === "" || channelId === "") {
    throw new TrentError({ code: EXIT.CONFIG, operation: "cron.deliver", message: "deliver target must be <platform>:<channel>, e.g. slack:#sales or telegram:123456", target });
  }
  return { platform, channelId };
}

/** [P1-D] A pinned job never runs on a model it did not name: the same refusal `./cron.ts` makes. */
function refusePinnedModel(options: CronRunOptions): void {
  const model = (options as { readonly model?: string }).model;
  if (model === undefined) return;
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "cron.run",
    message: `this job is pinned to model ${model}, and the runtime runs one configured model per process, so it cannot honour a per-job pin yet; the job was not run and no model was called. Re-add it without --model to run it on the configured model`,
    target: model,
  });
}

interface Wiring {
  readonly ctx: CommandContext;
  readonly config: TrentConfig;
  readonly runtime: HeadlessRuntime;
  readonly buildManager: BuildManager;
  /** The gateway's manager once started, else one built on the first delivery. */
  readonly sharedManager: () => GatewayManager;
}

function cronRunner(w: Wiring): CronRunner {
  const configManager = w.ctx.config();
  const owner = w.config.gateway.owner;
  const send = async (platform: string, channelId: string, text: string, subject: string, operation: string): Promise<void> => {
    const receipt = await w.sharedManager().send(platform, { channelId, text, metadata: { subject } });
    if (!receipt.sent) {
      throw new TrentError({ code: EXIT.PROVIDER, operation, message: `queued as ${receipt.queued} but not sent; the gateway will retry when ${platform} is reachable`, target: `${platform}:${channelId}` });
    }
  };
  return new CronRunner({
    profileDir: configManager.getProfileDir(),
    run: (prompt, options) => {
      refusePinnedModel(options);
      return w.runtime.run(prompt, { ...options, surface: "cron" });
    },
    handlers: { [SOCIAL_PUBLISH_HANDLER]: createSocialPublishHandler({ profileDir: configManager.getProfileDir(), social: { manager: configManager } }) },
    now: w.ctx.overrides.now,
    log: (line) => w.ctx.err(line),
    failureAlertAfter: w.config.cron.failure_alert_after,
    quotaHoldMinutes: w.config.cron.quota_hold_minutes,
    deliver: async (target, text, job) => {
      const { platform, channelId } = parseDeliverTarget(target);
      await send(platform, channelId, text, `Trent cron: ${job.name}`, "cron.deliver");
    },
    alert: async (text) => {
      if (owner === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "cron.alert", message: "gateway.owner is not configured; set gateway.owner { platform, channelId } in config.yaml" });
      await send(owner.platform, owner.channelId, text, "Trent cron: failure incident", "cron.alert");
    },
  });
}

export async function runServiceDaemon(ctx: CommandContext): Promise<CommandOutcome> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  const profileDir = configManager.getProfileDir();
  const gatewayOn = config.gateway.enabled;
  if (ctx.dryRun) return { data: { dryRun: true, command: "service daemon", profile: ctx.profile, components: daemonPlan(config) } };

  const log = new ServiceLog({ file: serviceLogPaths(profileDir).service, echo: (line) => ctx.err(line), now: ctx.overrides.now });
  log.line(`service starting: profile ${ctx.profile}`);
  try {
    refuseLiveHolders(profileDir, config);
  } catch (error) {
    log.line(`service stopped: ${reason(error)}`);
    throw error;
  }
  const releaseWriter = acquireProfileWriter(profileDir, "service");
  const buildManager: BuildManager = ctx.overrides.gatewayManager ?? ((cm, options) => new GatewayManager(cm, options));
  // Built after the runtime they hook into; the hooks resolve them lazily, as `gateway start` does.
  let manager: GatewayManager | undefined;
  let link: RunApprovalLink | undefined;
  let deliveryManager: GatewayManager | undefined;
  let runtime: HeadlessRuntime;
  try {
    runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
      configManager,
      config: config as unknown as ReplConfig,
      surface: gatewayOn ? "gateway" : "service",
      ...(gatewayOn
        ? {
            busHooks: [{ sink: (event) => link?.sink(event), flush: async () => undefined }],
            alerts: {
              manager: { send: (platform, message) => (manager === undefined ? Promise.reject(new Error("the gateway manager is not built yet")) : manager.send(platform, message)) },
              log: (line: string) => ctx.err(line),
            },
          }
        : {}),
    });
  } catch (error) {
    releaseWriter();
    log.line(`service stopped: ${reason(error)}`);
    throw error;
  }
  const built = runtime;
  const wiring: Wiring = { ctx, config, runtime: built, buildManager, sharedManager: () => manager ?? (deliveryManager ??= buildManager(configManager, {})) };

  const entries: ServiceEntry[] = [];
  if (gatewayOn) {
    entries.push({
      name: "gateway",
      async start() {
        const m = buildManager(configManager, { agentHandler: createAgentHandler(built, { configManager }) });
        manager = m;
        link = linkRunApprovals({ orchestrator: built.orchestrator, bridge: m.getApprovalBridge(), manager: m, owner: config.gateway.owner, log: (line) => ctx.err(line) });
        const release = async (): Promise<void> => {
          link?.close();
          await m.stopAll();
          manager = undefined;
        };
        let started: string[];
        try {
          started = await m.startAllConfigured();
        } catch (error) {
          await release();
          throw error;
        }
        if (started.length === 0) {
          await release();
          throw new TrentError({ code: EXIT.CONFIG, operation: "service.gateway", message: "gateway.enabled is true but no messaging platform started: configure one with trent gateway setup <platform> --token <token>, or set gateway.enabled false", target: "gateway.enabled" });
        }
        return started.join(", ");
      },
      async stop() {
        link?.close();
        await manager?.stopAll();
      },
    });
  } else entries.push({ name: "gateway", skipped: "gateway.enabled is false" });
  const runner = cronRunner(wiring);
  entries.push({
    name: "cron",
    start: () => {
      runner.start();
      return undefined;
    },
    stop: () => runner.stop(),
  });
  let loop: HeartbeatLoop | undefined;
  if (config.heartbeat.enabled) {
    // The loop only: `openHeartbeat().close()` would stop the shared manager before the gateway's own stop.
    const heartbeat = openHeartbeat({ configManager, config, runtime: built, buildManager: () => wiring.sharedManager(), now: ctx.overrides.now, log: (line) => ctx.err(line) }).loop;
    loop = heartbeat;
    entries.push({
      name: "heartbeat",
      start: () => {
        heartbeat.start();
        return undefined;
      },
      stop: () => heartbeat.stop(),
    });
  } else entries.push({ name: "heartbeat", skipped: "heartbeat.enabled is false" });

  const supervisor = new ServiceSupervisor({ components: entries, log: (line) => log.line(line) });
  // The writer registration and the last line happen whatever the runtime's cleanup does.
  const release = async (): Promise<void> => {
    try {
      await supervisor.stop();
      await deliveryManager?.stopAll().catch(() => undefined);
      await built.cleanup();
    } finally {
      releaseWriter();
      log.line("service stopped");
    }
  };
  let components: ServiceComponentReport[];
  try {
    components = await supervisor.start();
  } catch (error) {
    // The component's refusal is the error to report, not a cleanup failure behind it.
    await release().catch(() => undefined);
    throw error;
  }
  releaseOnSignal(release, ctx.overrides.signals);
  // The last resort for an exit that skips the release (a second Ctrl+C): drop the pid files.
  (ctx.overrides.signals ?? process).once("exit", () => {
    loop?.stop();
    runner.stop();
  });
  return { data: { pid: process.pid, profile: ctx.profile, components, log: log.path }, keepAlive: true };
}
