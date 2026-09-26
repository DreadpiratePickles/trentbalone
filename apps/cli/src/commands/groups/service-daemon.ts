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
 * [P2-10] The cron runner is `./cron.ts`'s own (`buildCronRunner`: the run, each delivery, the
 * incident alert, the social publish handler), so a pinned job runs on its pin here exactly as under
 * `cron start`: a child `trent run - --model <pin>` (`../../runtime/child-run.ts`).
 *
 * [P3] While `governance.auto_review.enabled`, a fourth component runs the auto reviewer's pass
 * every `AUTO_REVIEW_TICK_MS` (`autoReviewPass`, also handed to the heartbeat `gateway start` carries).
 */
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { TrentConfig } from "@trent/core";
import type { ConfigManager } from "@trent/core/config/index.js";
// [P3] the auto reviewer's automatic pass
import { DEFAULT_AUTO_REVIEW } from "@trent/core/governance/auto-review-config.js";
import { reviewHeldApprovals, type ReviewGateway, type ReviewPass } from "@trent/core/governance/auto-review.js";
import { openSpendLedger } from "@trent/core/governance/spend-ledger.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import { cronRunnerActive, cronRunnerLockPath, readCronRunnerLock } from "@trent/core/cron/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { FileGatewayStore, GatewayManager, linkRunApprovals, type RunApprovalLink } from "@trent/core/gateway/index.js"; // [P3] FileGatewayStore
import { heartbeatLockPath, heartbeatRunnerActive, type HeartbeatLoop } from "@trent/core/heartbeat/index.js";
import { acquireProfileWriter, gatewayRunningError, liveGatewayHolder, profileLockPath } from "@trent/core/profile/locks.js";
import { ServiceLog, ServiceSupervisor, serviceLogPaths, type ServiceComponentReport, type ServiceEntry } from "@trent/core/service/index.js";
import type { CommandOutcome } from "../registry.js";
import type { CommandContext } from "../context.js";
import { createAgentHandler, createRunResumer, createRunThreads } from "../../gateway/agent-handler.js"; // [S2] resumer, threads
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal } from "../../signals.js";
import { buildCronRunner } from "./cron.js";
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
    ...(autoReviewOn(config) ? [{ name: "auto-review", state: "would-start" as const }] : []), // [P3] listed only while the policy is on
  ];
}

// [P3] the auto reviewer's automatic pass
/** How often the daemon runs the reviewer's pass while `governance.auto_review.enabled`. */
export const AUTO_REVIEW_TICK_MS = 60_000;

let reviewGatewayForTests: (() => Promise<ReviewGateway>) | undefined;

/** Tests hand the pass a fake reviewer model; nothing else sets it. */
export function setAutoReviewGatewayForTests(gateway: (() => Promise<ReviewGateway>) | undefined): void {
  reviewGatewayForTests = gateway;
}

function autoReviewOn(config: TrentConfig): boolean {
  return config.governance?.auto_review?.enabled === true;
}

/**
 * One pass of `reviewHeldApprovals`, the function `trent approvals list --review` runs, with its deps
 * built as that command builds them (`./approvals.ts` runReview): the profile's `gateway.json`, the
 * written policy, the hardline, `approvals.deny`, the spend ledger, and a reviewer model built only
 * when a row is inside the policy. The config is read per pass, so `enabled: false` stops it at the
 * next tick. Single-flight: a tick that lands while a pass is running shares that pass.
 */
export function autoReviewPass(configManager: ConfigManager, log: (line: string) => void): () => Promise<ReviewPass> {
  let running: Promise<ReviewPass> | undefined;
  const once = async (): Promise<ReviewPass> => {
    const config = configManager.loadConfig();
    const policy = config.governance?.auto_review ?? DEFAULT_AUTO_REVIEW;
    const profileDir = configManager.getProfileDir();
    const gateway = async (): Promise<ReviewGateway> => {
      configManager.loadSecrets();
      const { createModelGateway } = await import("@trent/core/model-gateway/index.js");
      return createModelGateway({ preferredProvider: config.provider as ModelProvider, models: { executor: policy.model ?? config.model } });
    };
    const pass = await reviewHeldApprovals({
      store: new FileGatewayStore(path.join(profileDir, "gateway.json")),
      profileDir,
      policy,
      hardline: { home: os.homedir(), profileDir },
      deny: config.approvals?.deny ?? [],
      gateway: reviewGatewayForTests ?? gateway,
      spend: openSpendLedger({ profileDir }),
    });
    const decided = pass.outcomes.filter((outcome) => outcome.status !== "pending").length;
    if (pass.outcomes.length > 0) log(`auto-review: ${String(decided)} decided, ${String(pass.outcomes.length - decided)} left for a human`);
    return pass;
  };
  return () =>
    (running ??= once().finally(() => {
      running = undefined;
    }));
}

/** The daemon's fourth component: the pass on its own interval, stopped with the others. */
function autoReviewEntry(configManager: ConfigManager, log: (line: string) => void): ServiceEntry {
  const pass = autoReviewPass(configManager, log);
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    name: "auto-review",
    start: () => {
      timer = setInterval(() => void pass().catch((error: unknown) => log(`auto-review pass failed: ${reason(error)}`)), AUTO_REVIEW_TICK_MS);
      return undefined;
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
// [/P3]

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
      // [S2] Solo holds park only when the gateway sends cards to an owner; cron and the heartbeat are one-off runs and refuse them (B8).
      holds: gatewayOn && config.gateway.owner !== undefined ? "park" : "deny",
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
  /** The gateway's manager once started, else one built on the first delivery. */
  const sharedManager = (): GatewayManager => manager ?? (deliveryManager ??= buildManager(configManager, {}));

  const entries: ServiceEntry[] = [];
  if (gatewayOn) {
    entries.push({
      name: "gateway",
      async start() {
        const threads = createRunThreads(); // [S2]
        const m = buildManager(configManager, { agentHandler: createAgentHandler(built, { configManager, threads }), resumer: createRunResumer(built, threads, { configManager }) }); // [S2] resumer
        manager = m;
        link = linkRunApprovals({ orchestrator: built.runner ?? built.orchestrator, bridge: m.getApprovalBridge(), manager: m, owner: config.gateway.owner, log: (line) => ctx.err(line) }); // [S2] the runner by mode
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
  const runner = buildCronRunner(ctx, { configManager, config, runtime: built, manager: sharedManager });
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
    const heartbeat = openHeartbeat({ configManager, config, runtime: built, buildManager: sharedManager, now: ctx.overrides.now, log: (line) => ctx.err(line) }).loop;
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
  if (autoReviewOn(config)) entries.push(autoReviewEntry(configManager, (line) => log.line(line))); // [P3] only while the policy is on

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
