/**
 * The two protocol commands: `trent a2a` and `trent acp`.
 *
 * They are the specs `servers.ts` used to hold. They moved out when A2A grew the specification
 * transport and ACP grew its stdio one, because the combined file passed the 500-line limit
 * (apps/web/CLAUDE.md). `servers.ts` re-exports both, so the command registry is unchanged.
 *
 * `trent acp` is a SUBPROCESS protocol and therefore does not return while the editor holds the
 * pipe; `trent a2a serve` binds a socket and returns immediately with `keepAlive`, as every
 * socket-binding command here does.
 */

import { A2AServer, buildAgentCard, type A2AAgentCard } from "@trent/core/a2a/index.js";
import { ACPServer, ACPStdioAgent } from "@trent/core/acp/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { CLI_VERSION, type CommandSpec } from "../registry.js";
import { releaseOnSignal } from "../../signals.js";
import { A2A_DEFAULT_PORT, ACP_DEFAULT_PORT, listeningRender, openProtocolRuntime, parsePort } from "./protocol-runtime.js";

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
        // A delegated task is one real run on this runtime. Without it the endpoint can only
        // refuse (HTTP 503); it never answers on the runtime's behalf.
        const { runner, release } = await openProtocolRuntime(ctx, "a2a");
        const token = ctx.config().get("TRENT_A2A_TOKEN");
        const server = new A2AServer({ port, runner, ...(typeof token === "string" && token !== "" ? { token } : {}) });
        try {
          await server.start();
        } catch (error) {
          await release();
          throw error;
        }
        releaseOnSignal(async () => {
          await server.stop();
          await release();
        }, ctx.overrides.signals);
        return {
          data: { server: "a2a", port: server.getPort(), listening: true, runner: server.hasRunner() },
          keepAlive: true,
        };
      },
      render: listeningRender("a2a"),
    },
    {
      name: "card [agentId]",
      description: "Print the A2A Agent Card this server publishes at the well-known URI",
      options: [{ flags: "--endpoint <url>", description: "Advertised JSON-RPC endpoint" }],
      run(ctx, opts, args) {
        const endpoint = typeof opts.endpoint === "string" ? opts.endpoint : `http://127.0.0.1:${A2A_DEFAULT_PORT}/`;
        // `security` is truthful or absent: it appears only when a token is configured, because
        // only then does the server check one.
        const token = ctx.config().get("TRENT_A2A_TOKEN");
        const card = buildAgentCard({
          url: endpoint,
          version: CLI_VERSION,
          ...(typeof token === "string" && token !== "" ? { authenticated: true } : {}),
        });
        const seat = args[0];
        if (seat === undefined) return { data: card as unknown as Record<string, unknown> };

        const skill = card.skills.find((entry) => entry.id === seat);
        if (skill === undefined) {
          throw new TrentError({
            code: EXIT.USAGE,
            operation: "a2a.card",
            message: `no seat "${seat}" exists; the card carries one skill per seat`,
            target: seat,
          });
        }
        return { data: { ...card, skills: [skill] } as unknown as Record<string, unknown> };
      },
      render(data, ctx) {
        const d = data as unknown as A2AAgentCard;
        const lines = [
          `  ${ctx.theme.meta("agent")}    ${ctx.theme.value(d.name)}`,
          `  ${ctx.theme.meta("url")}      ${ctx.theme.value(d.url)}`,
          `  ${ctx.theme.meta("protocol")} ${ctx.theme.value(d.protocolVersion)}`,
        ];
        for (const skill of d.skills) lines.push(`  ${ctx.theme.meta("skill")}    ${ctx.theme.value(skill.id)} ${ctx.theme.meta(skill.name)}`);
        lines.push(`  ${ctx.theme.meta("use --json for the full card")}`);
        return lines;
      },
    },
  ],
};

export const acpSpec: CommandSpec = {
  name: "acp",
  description: "Agent Client Protocol for editors (VS Code, Cursor, Zed): stdio by default",
  options: [
    { flags: "--http", description: "Serve JSON-RPC over HTTP instead of stdio" },
    { flags: "--port <port>", description: "Port to bind with --http", defaultValue: ACP_DEFAULT_PORT },
  ],
  async run(ctx, opts) {
    const port = parsePort(opts.port, "acp", ACP_DEFAULT_PORT);
    const http = opts.http === true;
    if (ctx.dryRun) return { data: { dryRun: true, command: "acp", transport: http ? "http" : "stdio", port } };

    // A prompt from the editor is one real run on this runtime; with none attached the method
    // returns a JSON-RPC error rather than a string this process wrote.
    const { runner, release } = await openProtocolRuntime(ctx, "acp");
    let released = false;
    const releaseOnce = async (): Promise<void> => {
      if (released) return;
      released = true;
      await release();
    };

    if (!http) {
      // ACP is a SUBPROCESS protocol: the editor owns this process's stdin and stdout, and the
      // command runs until the editor closes the pipe. Nothing may be printed on stdout before
      // then, which is why the handler blocks here instead of reporting a listening socket.
      const agent = new ACPStdioAgent({ runner });
      releaseOnSignal(async () => {
        agent.abortAll();
        await releaseOnce();
      }, ctx.overrides.signals);
      try {
        await agent.serve();
      } finally {
        await releaseOnce();
      }
      return { data: { server: "acp", transport: "stdio", runner: agent.hasRunner(), closed: true } };
    }

    const server = new ACPServer({ port, configManager: ctx.config(), runner });
    try {
      await server.start();
    } catch (error) {
      await releaseOnce();
      throw error;
    }
    releaseOnSignal(async () => {
      await server.stop();
      await releaseOnce();
    }, ctx.overrides.signals);
    return {
      data: { server: "acp", transport: "http", port: server.getPort(), listening: true, runner: server.hasRunner() },
      keepAlive: true,
    };
  },
  render(data, ctx) {
    const d = data as { transport?: string; port?: number; dryRun?: boolean };
    if (d.transport === "stdio") return [`  ${ctx.theme.meta("acp stdio session closed")}`];
    return listeningRender("acp")(data, ctx);
  },
};
