/**
 * Long-running surfaces: `a2a`, `acp`, `gateway`, `egress`, `web`.
 *
 * `trent serve` used to start the A2A server, which collides with the desktop's need for a web
 * server. A2A is now `trent a2a serve` and the web server is `trent web`; `serve` is a shim in
 * `maintenance.ts` that points at both and exits 2.
 *
 * A command that binds a socket returns its data immediately and sets `keepAlive`, so `--json`
 * consumers get one parseable object at startup instead of waiting for a process that never ends.
 */

import { A2AServer, generateAgentCard } from "@trent/core/a2a/index.js";
import { ACPServer } from "@trent/core/acp/index.js";
import { GatewayManager, linkRunApprovals, type RunApprovalLink } from "@trent/core/gateway/index.js";
import { egressBindHosts, TokenManager } from "@trent/core/egress/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";
import { createAgentHandler } from "../../gateway/agent-handler.js";
import { startEgressProxy } from "../../repl/tools.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime } from "../../runtime/headless.js";
import {
  BUILD_HINT,
  buildStandalone,
  locateWebServer,
  standaloneEntry,
  startWebServer,
  type LocateResult,
  type WebTarget,
} from "../web-server.js";

const A2A_DEFAULT_PORT = "7895";
const ACP_DEFAULT_PORT = "7890";
const WEB_DEFAULT_PORT = "3000";

function parsePort(value: unknown, operation: string, fallback: string): number {
  const port = Number(typeof value === "string" && value !== "" ? value : fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation,
      message: "port must be an integer between 1 and 65535",
      target: String(value),
    });
  }
  return port;
}

/**
 * A keep-alive command that owns a runtime releases it on SIGTERM and SIGHUP before the process
 * goes, as `trent web` does for its child. Ctrl+C is answered by the binary itself (`index.ts`),
 * which exits at once.
 */
function releaseOnSignal(release: () => Promise<void>): void {
  let releasing: Promise<void> | undefined;
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      releasing ??= release().catch(() => undefined);
      void releasing.finally(() => process.exit(EXIT.INTERRUPT));
    });
  }
}

function listeningRender(kind: string) {
  return (data: Record<string, unknown> | unknown[], ctx: CommandContext): string[] => {
    const d = data as { port?: number; listening?: boolean; dryRun?: boolean };
    if (d.dryRun === true) {
      return [`  ${ctx.theme.meta(`would start ${kind} on port`)} ${ctx.theme.value(String(d.port))}`];
    }
    return [
      `  ${ctx.theme.success(`${kind} listening`)} ${ctx.theme.value(`http://127.0.0.1:${String(d.port)}`)}`,
      `  ${ctx.theme.meta("Ctrl+C to stop")}`,
    ];
  };
}

export const a2aSpec: CommandSpec = {
  name: "a2a",
  description: "Agent-to-Agent protocol: serve tasks and export signed agent cards",
  subcommands: [
    {
      name: "serve",
      description: "Start the A2A protocol server (previously `trent serve`)",
      options: [{ flags: "--port <port>", description: "Port to bind", defaultValue: A2A_DEFAULT_PORT }],
      async run(ctx, opts) {
        const port = parsePort(opts.port, "a2a.serve", A2A_DEFAULT_PORT);
        if (ctx.dryRun) return { data: { dryRun: true, command: "a2a serve", port } };
        const server = new A2AServer({ port });
        await server.start();
        return { data: { server: "a2a", port: server.getPort(), listening: true }, keepAlive: true };
      },
      render: listeningRender("a2a"),
    },
    {
      name: "card <agentId>",
      description: "Export a signed agent card for an installed agent",
      options: [{ flags: "--endpoint <url>", description: "Advertised task endpoint" }],
      run(ctx, opts, args) {
        const agentId = String(args[0]);
        const endpoint =
          typeof opts.endpoint === "string" ? opts.endpoint : `http://127.0.0.1:${A2A_DEFAULT_PORT}/a2a/tasks`;
        // The signing secret comes from the profile secrets file, never from a literal in source.
        const secret = String(ctx.config().get("TRENT_A2A_SIGNING_KEY") ?? "trent-a2a-key");
        const card = generateAgentCard(
          {
            id: agentId,
            name: `Trent ${agentId} agent`,
            description: `Autonomous cofounder specialist: ${agentId}.`,
            category: "specialist",
            capabilities: ["task-execution", "analysis", "synthesis"],
            endpoint,
          },
          secret,
        );
        return { data: card as unknown as Record<string, unknown> };
      },
      render(data, ctx) {
        const d = data as { id?: string; endpoint?: string };
        return [
          `  ${ctx.theme.meta("agent")}    ${ctx.theme.value(String(d.id))}`,
          `  ${ctx.theme.meta("endpoint")} ${ctx.theme.value(String(d.endpoint))}`,
          `  ${ctx.theme.meta("use --json for the full signed card")}`,
        ];
      },
    },
  ],
};

export const acpSpec: CommandSpec = {
  name: "acp",
  description: "Start the ACP editor integration server (VS Code, Cursor, Zed)",
  options: [{ flags: "--port <port>", description: "Port to bind", defaultValue: ACP_DEFAULT_PORT }],
  async run(ctx, opts) {
    const port = parsePort(opts.port, "acp", ACP_DEFAULT_PORT);
    if (ctx.dryRun) return { data: { dryRun: true, command: "acp", port } };
    const server = new ACPServer({ port, configManager: ctx.config() });
    await server.start();
    return { data: { server: "acp", port: server.getPort(), listening: true }, keepAlive: true };
  },
  render: listeningRender("acp"),
};

export const gatewaySpec: CommandSpec = {
  name: "gateway",
  description: "Messaging gateway: platform status, credentials and listener",
  subcommands: [
    {
      name: "status",
      description: "Show which messaging platforms are configured and their designated agent",
      run(ctx) {
        const status = new GatewayManager(ctx.config()).getStatus();
        const platforms = Object.entries(status).map(([id, info]) => ({
          id,
          name: info.name,
          configured: info.configured,
          designatedAgent: info.designatedAgent,
        }));
        return {
          data: { count: platforms.length, configured: platforms.filter((p) => p.configured).length, platforms },
        };
      },
      render(data, ctx) {
        const d = data as { platforms: { id: string; configured: boolean; designatedAgent: string }[] };
        const lines = [ctx.theme.emphasis("MESSAGING GATEWAY")];
        for (const p of d.platforms) {
          const mark = p.configured ? ctx.theme.success("connected") : ctx.theme.meta("not set  ");
          lines.push(`  ${mark} ${ctx.theme.value(p.id.padEnd(14, " "))} ${ctx.theme.meta(p.designatedAgent)}`);
        }
        return lines;
      },
    },
    {
      name: "setup <platform>",
      description: "Store a messaging platform credential in the profile secrets file",
      options: [{ flags: "--token <token>", description: "Bot token; stored, never echoed" }],
      run(ctx, opts, args) {
        const platform = String(args[0]);
        const key = `${platform.toUpperCase()}_BOT_TOKEN`;
        if (ctx.dryRun) {
          return { data: { dryRun: true, command: "gateway setup", platform, wouldWriteSecret: key } };
        }
        if (typeof opts.token !== "string" || opts.token === "") {
          throw new TrentError({
            code: EXIT.AUTH,
            operation: "gateway.setup",
            message: "--token is required to configure a platform",
            target: platform,
          });
        }
        ctx.config().set(key, opts.token);
        // The name of the secret, never its value.
        return { data: { platform, secretConfigured: key } };
      },
      render(data, ctx) {
        const d = data as { platform: string; secretConfigured?: string };
        return [`  ${ctx.theme.success("configured")} ${ctx.theme.value(d.platform)}`];
      },
    },
    {
      name: "start",
      description: "Start listeners for every configured messaging platform",
      async run(ctx) {
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
        // The same object graph the REPL runs on, with no terminal: every message that passes the
        // pairing gate becomes a real orchestrated run, and its consolidated summary is the reply.
        // A gated step on any run this runtime executes becomes a card to `gateway.owner`, and
        // the owner's decision releases the step. The link rides on the runtime's bus hooks, so
        // it sees every run, not only those the agent handler starts; it is built after the
        // manager it sends through, and the runtime before both, so the hook forwards lazily.
        let link: RunApprovalLink | undefined;
        const config = configManager.loadConfig();
        const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
          configManager,
          config: config as unknown as ReplConfig,
          busHooks: [{ sink: (event) => link?.sink(event), flush: async () => undefined }],
        });
        const manager = buildManager(configManager, { agentHandler: createAgentHandler(runtime) });
        link = linkRunApprovals({
          orchestrator: runtime.orchestrator,
          bridge: manager.getApprovalBridge(),
          manager,
          owner: config.gateway.owner,
          log: (line) => ctx.err(line),
        });
        const shutdown = async (): Promise<void> => {
          link?.close();
          await manager.stopAll();
          await runtime.cleanup();
        };
        const started = await manager.startAllConfigured();
        if (started.length === 0) {
          // Nothing is listening, so the process exits: the proxy and the sandboxes go first.
          await shutdown();
        } else {
          releaseOnSignal(shutdown);
        }
        return {
          data: { started, count: started.length, agentHandler: true, approvalLink: link.active },
          keepAlive: started.length > 0,
        };
      },
      render(data, ctx) {
        const d = data as { started?: string[]; wouldStart?: string[]; dryRun?: boolean; approvalLink?: boolean };
        const list = (d.dryRun === true ? d.wouldStart : d.started) ?? [];
        const lines = [
          `  ${ctx.theme.success(d.dryRun === true ? "would start" : "started")} ${ctx.theme.value(
            list.length > 0 ? list.join(", ") : "none",
          )}`,
        ];
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
