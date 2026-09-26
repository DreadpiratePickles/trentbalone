/**
 * Long-running surfaces: `gateway`, `egress`, `web`. The `a2a` and `acp` specs live in
 * `protocol-commands.ts` and are re-exported here, so the registry's import is unchanged.
 *
 * `trent serve` used to start the A2A server, which collides with the desktop's need for a web
 * server. A2A is now `trent a2a serve` and the web server is `trent web`; `serve` is a shim in
 * `maintenance.ts` that points at both and exits 2.
 *
 * A command that binds a socket returns its data immediately and sets `keepAlive`, so `--json`
 * consumers get one parseable object at startup instead of waiting for a process that never ends.
 */

import { ConfigManager } from "@trent/core/config/index.js";
import { GatewayManager, linkRunApprovals, readSetting, WebhookServer, webhookOnly, type RunApprovalLink } from "@trent/core/gateway/index.js"; // [P3] readSetting, WebhookServer, webhookOnly
import { gatewayRunningError, liveGatewayHolder, profileLockPath, type ProfileLockHolder } from "@trent/core/profile/locks.js";
import { egressBindHosts, TokenManager } from "@trent/core/egress/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { openWebhookRoutes, webhookStatus, webhookStatusLines, WebhooksConfigSchema, type OpenedWebhookRoutes, type WebhooksConfig, type WebhookStatusView } from "@trent/core/webhooks/index.js"; // [H3] webhook routes; [P3] WebhooksConfigSchema, WebhooksConfig
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";
import { createAgentHandler, createRunResumer, createRunThreads, typingFromAdapters } from "../../gateway/agent-handler.js"; // [S2] resumer, threads; [CF] typingFromAdapters
import { modeOverride } from "../../runtime/runner-for-mode.js"; // [S2] --solo
import { startEgressProxy } from "../../repl/tools.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal } from "../../signals.js";
import { openHeartbeat } from "./heartbeat.js";
import { gatewaySetupSpec } from "./gateway-setup.js"; // [P3]
import { gatewayPairSpecs } from "./gateway-pair.js"; // [C7]
import { noteInboundRun } from "@trent/core/governance/bound-approvals.js"; // [P3]
import { autoReviewPass } from "./service-daemon.js"; // [P3] the auto reviewer's pass on each heartbeat tick
import { ACP_DEFAULT_PORT, listeningRender, parsePort, WEB_DEFAULT_PORT } from "./protocol-runtime.js";
import {
  BUILD_HINT,
  buildStandalone,
  locateWebServer,
  standaloneEntry,
  startWebServer,
  type LocateResult,
  type WebTarget,
} from "../web-server.js";

export { a2aSpec, acpSpec } from "./protocol-commands.js";

/** Every profile on this host whose gateway lock names a live process: the host-level view. */
function gatewaysOnHost(manager: ConfigManager): Array<{ profile: string } & ProfileLockHolder> {
  return manager.listProfiles().flatMap((profile) => {
    const holder = liveGatewayHolder(new ConfigManager({ baseDir: manager.getBaseDir(), profile }).getProfileDir());
    return holder === null ? [] : [{ profile, ...holder }];
  });
}

// [P3] a webhook-only adapter needs the listener even when no signed route is configured
/** The started platforms whose inbound arrives only at `/webhooks/<id>` under this profile's settings. */
function webhookOnlyStarted(started: readonly string[], configManager: ConfigManager): string[] {
  const setting = (key: string): string | undefined => readSetting({ config: configManager, store: undefined as never }, key);
  return started.filter((id) => webhookOnly(id, setting));
}

/** The gateway's `WebhookServer` with no route mounted, serving `/webhooks/<platform>` where `gateway.webhooks` says. */
async function openAdapterWebhooks(manager: GatewayManager, block: WebhooksConfig | undefined): Promise<OpenedWebhookRoutes> {
  const where = block ?? WebhooksConfigSchema.parse({});
  const server = new WebhookServer(manager);
  const port = await server.listen(where.port, where.host);
  return { host: where.host, port, routes: [], close: () => server.close() };
}

interface GatewayLockView {
  readonly running: boolean;
  readonly pid?: number;
  readonly label?: string;
  readonly startedAt?: string;
}

export const gatewaySpec: CommandSpec = {
  name: "gateway",
  description: "Messaging gateway: platform status, credentials and listener",
  subcommands: [
    {
      name: "status",
      description: "Show which messaging platforms are configured and their designated agent",
      run(ctx) {
        const manager = ctx.config();
        const status = new GatewayManager(manager).getStatus();
        const platforms = Object.entries(status).map(([id, info]) => ({
          id,
          name: info.name,
          configured: info.configured,
          designatedAgent: info.designatedAgent,
        }));
        // Whether a gateway holds this profile's lock (the pid to stop), and which profiles on this
        // host run one: one gateway per profile, several per host (`@trent/core/profile/locks`).
        const holder = liveGatewayHolder(manager.getProfileDir());
        const gateway: GatewayLockView = holder === null ? { running: false } : { running: true, ...holder };
        // [H3] webhook routes: the configured routes and the last deliveries from the profile's store.
        const webhooks = webhookStatus(manager.getProfileDir(), manager.loadConfig().gateway.webhooks);
        return {
          data: { count: platforms.length, configured: platforms.filter((p) => p.configured).length, platforms, gateway, gateways: gatewaysOnHost(manager), webhooks },
        };
      },
      render(data, ctx) {
        const d = data as { platforms: { id: string; configured: boolean; designatedAgent: string }[]; gateway: GatewayLockView; gateways: Array<{ profile: string; pid: number }>; webhooks?: WebhookStatusView };
        const lines = [ctx.theme.emphasis("MESSAGING GATEWAY")];
        lines.push(
          d.gateway.running
            ? `  ${ctx.theme.success("running")}   ${ctx.theme.value(`pid ${String(d.gateway.pid)}`)} ${ctx.theme.meta(`${d.gateway.label ?? ""} since ${d.gateway.startedAt ?? "?"}`)}`
            : `  ${ctx.theme.meta("not running on this profile")}`,
        );
        for (const other of d.gateways.filter((g) => g.profile !== ctx.profile)) {
          lines.push(`  ${ctx.theme.meta(`also running on profile ${other.profile}:`)} ${ctx.theme.value(`pid ${String(other.pid)}`)}`);
        }
        for (const p of d.platforms) {
          const mark = p.configured ? ctx.theme.success("connected") : ctx.theme.meta("not set  ");
          lines.push(`  ${mark} ${ctx.theme.value(p.id.padEnd(14, " "))} ${ctx.theme.meta(p.designatedAgent)}`);
        }
        // [H3] webhook routes: shown only when a route is configured or a delivery is on record.
        if (d.webhooks !== undefined && (d.webhooks.routes.length > 0 || d.webhooks.last.length > 0)) {
          for (const line of webhookStatusLines(d.webhooks)) lines.push(`  ${ctx.theme.meta(line)}`);
        }
        return lines;
      },
    },
    gatewaySetupSpec, // [P3] the names each adapter reads, from the registry (./gateway-setup.ts)
    ...gatewayPairSpecs, // [C7] pair, pairings, revoke (./gateway-pair.ts)
    {
      name: "start",
      description: "Start listeners for every configured messaging platform",
      async run(ctx, opts) {
        const configManager = ctx.config();
        const buildManager = ctx.overrides.gatewayManager ?? ((cm, options) => new GatewayManager(cm, options));
        if (ctx.dryRun) {
          const status = buildManager(configManager, {}).getStatus();
          return {
            data: {
              dryRun: true,
              command: "gateway start",
              wouldStart: Object.entries(status)
                .filter(([, i]) => i.configured)
                .map(([id]) => id),
            },
          };
        }
        // One gateway per profile: a live holder of this profile's gateway lock is refused here,
        // before a runtime, a proxy or a sandbox exists. The manager takes the lock itself when it
        // starts, so a gateway that slips in after this check is still refused below.
        const holder = liveGatewayHolder(configManager.getProfileDir());
        if (holder !== null) throw gatewayRunningError("gateway.start", holder, profileLockPath(configManager.getProfileDir(), "gateway"));
        // The same object graph the REPL runs on, with no terminal: every message that passes the
        // pairing gate becomes a real orchestrated run, and its consolidated summary is the reply.
        // A gated step on any run this runtime executes becomes a card to `gateway.owner`, and
        // the owner's decision releases the step. The link rides on the runtime's bus hooks, so
        // it sees every run, not only those the agent handler starts; it is built after the
        // manager it sends through, and the runtime before both, so the hook forwards lazily.
        // Push alerts (failures, unanswered gates) go through the same manager, handed to the
        // runtime as a sender that resolves the manager lazily for the same reason.
        let link: RunApprovalLink | undefined;
        let manager: GatewayManager | undefined;
        const config = configManager.loadConfig();
        const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
          configManager,
          config: config as unknown as ReplConfig,
          // [G3.1] Every run this gateway serves is charged to the day's ledger as the gateway's;
          // the cron and heartbeat ports built on this same runtime name themselves per run.
          surface: "gateway",
          // [S2] Solo holds park only when a human receives the cards (gateway.owner); with none they are refused (B8).
          holds: config.gateway.owner === undefined ? "deny" : "park",
          ...(modeOverride(opts) === undefined ? {} : { mode: modeOverride(opts) }), // [S2] --solo
          busHooks: [{ sink: (event) => link?.sink(event), flush: async () => undefined }],
          alerts: {
            manager: {
              send: (platform, message) => {
                if (manager === undefined) return Promise.reject(new Error("the gateway manager is not built yet"));
                return manager.send(platform, message);
              },
            },
            log: (line) => ctx.err(line),
          },
        });
        const threads = createRunThreads(); // [S2] a solo run's thread, for its reply after a late decision
        // [CF] H: the platform's typing action while a solo turn runs (C13), looked up on this manager at send time.
        const typing = typingFromAdapters((platform) => manager?.getAdapter(platform)); // [CF]
        manager = buildManager(configManager, { agentHandler: createAgentHandler(runtime, { configManager, threads, typing }), resumer: createRunResumer(runtime, threads, { configManager }) }); // [S2] resumer; [CF] typing
        link = linkRunApprovals({
          orchestrator: runtime.runner ?? runtime.orchestrator, // [S2] the runner by mode is the approval target
          bridge: manager.getApprovalBridge(),
          manager,
          owner: config.gateway.owner,
          log: (line) => ctx.err(line),
        });
        // The heartbeat (T1.2) rides on the same runtime and delivers through the same manager,
        // so a gateway that is up is also the founder's periodic check when `heartbeat.enabled`.
        const heartbeat = config.heartbeat.enabled
          ? openHeartbeat({ configManager, config, runtime, buildManager: () => manager as GatewayManager, now: ctx.overrides.now, log: (line) => ctx.err(line) })
          : undefined;
        if (config.governance?.auto_review?.enabled === true) heartbeat?.loop.beforeEachTick(autoReviewPass(configManager, (line) => ctx.err(line))); // [P3]
        let webhooks: OpenedWebhookRoutes | undefined; // [H3] webhook routes
        const shutdown = async (): Promise<void> => {
          await webhooks?.close(); // [H3] no new run starts once shutdown begins
          heartbeat?.loop.stop();
          link?.close();
          await manager.stopAll();
          await runtime.cleanup();
        };
        let started: string[];
        let hooked: string[] = []; // [P3] the started platforms that listen only on /webhooks/<id>
        try {
          started = await manager.startAllConfigured();
          // [H3] webhook routes: served under this profile's gateway lock, each run through this
          // runtime's runner port; a route whose mode is not this runtime's is answered 503.
          webhooks = await openWebhookRoutes({
            block: config.gateway.webhooks,
            profileDir: configManager.getProfileDir(),
            manager,
            // [S2] H3: a route's mode runs whatever the gateway's agent.mode; the seed lands in the ring the tools are judged against.
            // A runtime without the two seams (a test's partial fake) keeps the rule it had: its own mode only, no seed.
            runnerFor: (mode) => runtime.runnerFor?.(mode) ?? (mode === runtime.mode ? runtime.runner : undefined),
            seedInbound: async (runId, source) => {
              noteInboundRun(runId); // [P3] the run's held calls are stamped untrusted_inbound, whatever ring the tools use
              await runtime.seedInbound?.(runId, source);
            },
            log: (line) => ctx.err(line),
          });
          // [P3] LINE, WhatsApp and the other webhook-only adapters are served by the same listener, route or none.
          hooked = webhookOnlyStarted(started, configManager);
          if (webhooks === undefined && hooked.length > 0) webhooks = await openAdapterWebhooks(manager, config.gateway.webhooks);
        } catch (error) {
          // Refused by the profile's gateway lock: nothing this command built may outlive the refusal.
          await shutdown();
          throw error;
        }
        const serving = started.length > 0 || webhooks !== undefined; // [H3] webhook routes keep it up too
        if (!serving) {
          // Nothing is listening, so the process exits: the proxy and the sandboxes go first.
          await shutdown();
        } else {
          try {
            heartbeat?.loop.start();
          } catch (error) {
            await shutdown();
            throw error;
          }
          // Ctrl+C too, not only SIGTERM/SIGHUP: the claim makes the binary's global handler wait
          // for this release instead of exiting on top of it (../../signals.ts).
          releaseOnSignal(shutdown, ctx.overrides.signals);
        }
        return {
          data: {
            started,
            count: started.length,
            agentHandler: true,
            approvalLink: link.active,
            heartbeat: heartbeat !== undefined && serving,
            ...(webhooks === undefined ? {} : { webhooks: { listen: `${webhooks.host}:${String(webhooks.port)}`, routes: webhooks.routes, adapters: hooked } }), // [H3]; [P3] adapters
          },
          keepAlive: serving,
        };
      },
      render(data, ctx) {
        const d = data as { started?: string[]; wouldStart?: string[]; dryRun?: boolean; approvalLink?: boolean; heartbeat?: boolean; webhooks?: { listen: string; routes: string[]; adapters?: string[] } };
        const list = (d.dryRun === true ? d.wouldStart : d.started) ?? [];
        const lines = [
          `  ${ctx.theme.success(d.dryRun === true ? "would start" : "started")} ${ctx.theme.value(
            list.length > 0 ? list.join(", ") : "none",
          )}`,
        ];
        if (d.heartbeat === true) lines.push(`  ${ctx.theme.meta("heartbeat loop running; history under <profile>/heartbeat/runs.jsonl")}`);
        if (d.webhooks !== undefined) lines.push(`  ${ctx.theme.meta("webhooks on")} ${ctx.theme.value(d.webhooks.listen)} ${ctx.theme.meta([...d.webhooks.routes, ...(d.webhooks.adapters ?? []).map((id) => `/webhooks/${id}`)].join(", "))}`); // [H3]; [P3] adapters
        if (d.approvalLink !== undefined) {
          lines.push(
            d.approvalLink
              ? `  ${ctx.theme.meta("run approvals go to")} ${ctx.theme.value("gateway.owner")}`
              : `  ${ctx.theme.meta("run approvals stay local: set gateway.owner { platform, channelId } in config.yaml")}`,
          );
        }
        return lines;
      },
    },
  ],
};

export const egressSpec: CommandSpec = {
  name: "egress",
  description: "Egress credential isolation proxy",
  subcommands: [
    {
      name: "setup",
      description: "Configure the egress proxy port and intercept domains",
      options: [{ flags: "--port <port>", description: "Port to bind", defaultValue: "8089" }],
      run(ctx, opts) {
        const port = parsePort(opts.port, "egress.setup", "8089");
        if (ctx.dryRun) return { data: { dryRun: true, command: "egress setup", port } };
        const config = ctx.config().loadConfig();
        config.egress.proxy_port = port;
        ctx.config().saveConfig(config);
        return { data: { port, interceptDomains: config.egress.intercept_domains } };
      },
      render(data, ctx) {
        const d = data as { port: number };
        return [`  ${ctx.theme.success("egress port")} ${ctx.theme.value(String(d.port))}`];
      },
    },
    {
      name: "start",
      description: "Start the egress credential proxy daemon (the REPL starts its own, session-scoped, on a free port)",
      async run(ctx) {
        const config = ctx.config().loadConfig();
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "egress start", port: config.egress.proxy_port } };
        }
        // The same start path the REPL uses, on the CONFIGURED port with the DURABLE token store, so
        // tokens issued by other commands resolve here. The issued token is never printed.
        // Same bind rule as the REPL: loopback, plus the Docker bridge gateway on Linux so the
        // sandbox containers can reach the proxy (token-gated; wildcards are refused).
        const bindHosts = await egressBindHosts({ backend: config.terminal.backend === "docker" ? "docker" : "local" });
        const proxy = await startEgressProxy({
          configManager: ctx.config(),
          port: config.egress.proxy_port,
          tokenManager: new TokenManager(),
          bindHosts,
        });
        return {
          data: {
            server: "egress",
            port: proxy.port,
            bindHosts,
            listening: proxy.isListening(),
            interceptDomains: [...config.egress.intercept_domains],
            caCertPath: proxy.caCertPath,
          },
          keepAlive: true,
        };
      },
      render: listeningRender("egress proxy"),
    },
  ],
};

/**
 * `trent web` — the desktop's web server, which is why A2A had to give up the name `serve`.
 * Without `--start` it reports what would be served; with it, it runs the same `.next/standalone`
 * tree the desktop sidecar runs (see ../web-server.ts) and stays up until Ctrl+C.
 */
export const webSpec: CommandSpec = {
  name: "web",
  description: "Report or start the Trent web server for the desktop surface",
  options: [
    { flags: "--port <port>", description: "Port to bind; 0 picks a free one", defaultValue: WEB_DEFAULT_PORT },
    { flags: "--start", description: "Start the server rather than reporting readiness" },
    { flags: "--build", description: "With --start: run the standalone build first if it is missing" },
    { flags: "--open", description: "With --start: open the URL in the default browser once ready" },
  ],
  async run(ctx, opts) {
    const port = parseWebPort(opts.port);
    const located = locateWebServer({
      repoRoot: ctx.overrides.webRepoRoot ?? process.cwd(),
      home: ctx.config().getBaseDir(),
    });
    const report = describeLocation(located, port);

    if (ctx.dryRun) return { data: { dryRun: true, command: "web", ...report } };
    if (opts.start !== true) return { data: report };

    let target: WebTarget;
    if (located.kind === "found") {
      target = located.target;
    } else if (located.kind === "unbuilt" && opts.build === true) {
      await buildStandalone(ctx, located.appDir);
      const entry = standaloneEntry(located.appDir);
      if (entry === undefined) {
        throw new TrentError({ code: EXIT.CONFIG, operation: "web.build", message: "the build finished but produced no standalone server.js", target: located.appDir });
      }
      target = { source: "clone", entry, appDir: located.appDir };
    } else if (located.kind === "unbuilt") {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "web.start",
        message: `the standalone web build is missing; run \`${BUILD_HINT}\` or pass --build to build it now`,
        target: located.appDir,
      });
    } else {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "web.start",
        message: "no web application found: run from a clone, or `trent desktop install` provides the web resources",
        target: located.tried.join(", "),
      });
    }

    const started = await startWebServer(ctx, target, { port, build: opts.build === true, open: opts.open === true });
    return {
      data: { port: started.port, url: started.url, pid: started.pid, source: started.source },
      keepAlive: true,
    };
  },
  render(data, ctx) {
    const d = data as {
      dryRun?: boolean;
      url?: string;
      pid?: number;
      source?: string;
      entry?: string;
      port: number;
      state?: string;
      hint?: string;
    };
    if (d.url !== undefined) {
      return [
        `  ${ctx.theme.success("web listening")} ${ctx.theme.value(d.url)} ${ctx.theme.meta(`(${d.source ?? ""}, pid ${String(d.pid)})`)}`,
        `  ${ctx.theme.meta("Ctrl+C to stop")}`,
      ];
    }
    const lines = [
      `  ${ctx.theme.meta("port")}   ${ctx.theme.value(String(d.port))}`,
      `  ${ctx.theme.meta("source")} ${ctx.theme.value(d.source ?? "none")}`,
    ];
    if (d.entry !== undefined) lines.push(`  ${ctx.theme.meta("entry")}  ${ctx.theme.value(d.entry)}`);
    lines.push(d.state === "ready" ? ctx.theme.success(`  web server ${d.dryRun === true ? "would start" : "ready to start"}`) : ctx.theme.error(`  ${d.hint ?? ""}`));
    return lines;
  },
};

/** Like `parsePort`, but 0 is allowed: it asks the OS for a free port, as the desktop does. */
function parseWebPort(value: unknown): number {
  const raw = typeof value === "string" && value !== "" ? value : WEB_DEFAULT_PORT;
  if (raw === "0") return 0;
  return parsePort(raw, "web", WEB_DEFAULT_PORT);
}

function describeLocation(located: LocateResult, port: number): Record<string, unknown> {
  if (located.kind === "found") {
    return { port, state: "ready", source: located.target.source, entry: located.target.entry, appDir: located.target.appDir };
  }
  if (located.kind === "unbuilt") {
    return { port, state: "unbuilt", appDir: located.appDir, hint: `standalone build missing: ${BUILD_HINT} (or --start --build)` };
  }
  return { port, state: "absent", tried: located.tried, hint: "no web application found; `trent desktop install` provides one" };
}
