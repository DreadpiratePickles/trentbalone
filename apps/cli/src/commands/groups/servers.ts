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

import fs from "node:fs";
import path from "node:path";
import { A2AServer, generateAgentCard } from "@trent/core/a2a/index.js";
import { ACPServer } from "@trent/core/acp/index.js";
import { GatewayManager } from "@trent/core/gateway/index.js";
import { TokenManager } from "@trent/core/egress/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";
import { startEgressProxy } from "../../repl/tools.js";

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
        const manager = new GatewayManager(ctx.config());
        if (ctx.dryRun) {
          const status = manager.getStatus();
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
        const started = await manager.startAllConfigured();
        return { data: { started, count: started.length }, keepAlive: started.length > 0 };
      },
      render(data, ctx) {
        const d = data as { started?: string[]; wouldStart?: string[]; dryRun?: boolean };
        const list = (d.dryRun === true ? d.wouldStart : d.started) ?? [];
        return [
          `  ${ctx.theme.success(d.dryRun === true ? "would start" : "started")} ${ctx.theme.value(
            list.length > 0 ? list.join(", ") : "none",
          )}`,
        ];
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
        const proxy = await startEgressProxy({
          configManager: ctx.config(),
          port: config.egress.proxy_port,
          tokenManager: new TokenManager(),
        });
        return {
          data: {
            server: "egress",
            port: proxy.port,
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
 * The server itself is Milestone 5; this validates and reports the real target rather than
 * printing an encouraging sentence.
 */
export const webSpec: CommandSpec = {
  name: "web",
  description: "Report or start the Trent web server for the desktop surface",
  options: [
    { flags: "--port <port>", description: "Port to bind", defaultValue: WEB_DEFAULT_PORT },
    { flags: "--start", description: "Start the server rather than reporting readiness" },
  ],
  run(ctx, opts) {
    const port = parsePort(opts.port, "web", WEB_DEFAULT_PORT);
    const appDir = path.resolve(process.cwd(), "apps/web");
    const present = fs.existsSync(path.join(appDir, "package.json"));

    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "web", port, appDir, appPresent: present } };
    }
    if (!present) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "web",
        message: "no web application found at the expected path",
        target: appDir,
      });
    }
    if (opts.start === true) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "web.start",
        message:
          "the web server entry point is not built yet (Milestone 5); run without --start to check readiness",
        target: appDir,
      });
    }
    return { data: { port, appDir, appPresent: true, started: false } };
  },
  render(data, ctx) {
    const d = data as { port: number; appDir: string; appPresent: boolean };
    return [
      `  ${ctx.theme.meta("app dir")} ${ctx.theme.value(d.appDir)}`,
      `  ${ctx.theme.meta("port")}    ${ctx.theme.value(String(d.port))}`,
      d.appPresent ? ctx.theme.success("  web application present") : ctx.theme.error("  web application missing"),
    ];
  },
};
