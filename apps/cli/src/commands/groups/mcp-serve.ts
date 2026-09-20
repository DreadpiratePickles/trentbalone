/**
 * `trent mcp serve [--stdio | --http --host H --port N --token-env NAME]` (U5 / G9).
 *
 * Trent as an MCP server: the profile's enabled toolsets, plus the fleet-memory adapters
 * (`memory`, `fleet_search`, `brain_read`), as MCP tools for any MCP client. The adapters are the
 * ones the headless runtime built (`buildTrentTools` wrapped them), so a call from a host crosses
 * the same autonomy, hardline, deny-glob, floor, policy, idempotency, provenance and hook chain a
 * seat's call crosses; the runtime is opened on the `mcp` surface so its spend is charged there.
 *
 * stdio is the default and is a SUBPROCESS protocol: the host owns this process's pipes, nothing
 * is printed on stdout until the host hangs up, and the command returns when it does. `--http`
 * binds Streamable HTTP, loopback by default; a non-loopback host needs a bearer token, read from
 * the variable `--token-env` names (`TRENT_MCP_TOKEN` by default, which the profile secrets file
 * exports), and the refusal happens before any runtime is built. The token's value is never
 * printed. Every MCP session is one Trent server with its own run scope.
 */
import process from "node:process";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { createMcpHttpServer, createTrentMcpServer, isLoopbackHost, MCP_DEFAULT_HOST, MCP_DEFAULT_PORT, serveStdio, type TrentMcpServer } from "@trent/core/mcp-server/index.js";
import { closeRunScope, openRunScope } from "@trent/core/orchestrator/run-hooks.js";
import type { TrentToolAdapter } from "@trent/core/tools/types.js";
import type { CommandContext } from "../context.js";
import { CLI_VERSION, type CommandSpec } from "../registry.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal } from "../../signals.js";
import { parsePort } from "./protocol-runtime.js";

export const MCP_SURFACE_NAME = "mcp";
export const MCP_TOKEN_ENV = "TRENT_MCP_TOKEN";

interface ServeOptions {
  readonly transport: "stdio" | "http";
  readonly host: string;
  readonly port: number;
  readonly tokenEnv: string;
}

function readOptions(opts: Record<string, unknown>): ServeOptions {
  if (opts.stdio === true && opts.http === true) {
    throw new TrentError({ code: EXIT.USAGE, operation: "mcp.serve", message: "give --stdio or --http, not both" });
  }
  return {
    transport: opts.http === true ? "http" : "stdio",
    host: typeof opts.host === "string" && opts.host !== "" ? opts.host : MCP_DEFAULT_HOST,
    port: parsePort(opts.port, "mcp.serve", String(MCP_DEFAULT_PORT)),
    tokenEnv: typeof opts.tokenEnv === "string" && opts.tokenEnv !== "" ? opts.tokenEnv : MCP_TOKEN_ENV,
  };
}

/**
 * The bearer for `--http`: the named variable's value, from the process env after the profile
 * secrets have been exported into it. Naming a variable that is unset is an error; naming none
 * on a non-loopback host is the A2A card's refusal, made before a socket or a runtime exists.
 */
function readToken(ctx: CommandContext, options: ServeOptions, explicit: boolean): string | undefined {
  ctx.config().loadSecrets();
  const value = process.env[options.tokenEnv];
  if (value !== undefined && value !== "") return value;
  if (explicit) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "mcp.serve", message: "the variable named by --token-env is unset", target: options.tokenEnv });
  }
  if (!isLoopbackHost(options.host)) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "mcp.serve",
      message: `a non-loopback host needs a bearer token: set ${MCP_TOKEN_ENV} in the profile secrets file or name a variable with --token-env`,
      target: options.host,
    });
  }
  return undefined;
}

async function openRuntime(ctx: CommandContext): Promise<HeadlessRuntime> {
  const configManager = ctx.config();
  const config = configManager.loadConfig();
  return (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config: config as unknown as ReplConfig, surface: MCP_SURFACE_NAME });
}

/** The seat's list, exactly: the built toolsets, then the fleet-memory adapters the orchestrator appends. */
function adaptersOf(runtime: HeadlessRuntime): TrentToolAdapter[] {
  return [...runtime.tools.adapters, ...(runtime.fleetMemory?.adapters ?? [])];
}

/** One connection: one server, one run scope on the `mcp` surface, closed with the connection. */
function connection(runtime: HeadlessRuntime, profileDir: string, adapters: readonly TrentToolAdapter[]): TrentMcpServer {
  const server = createTrentMcpServer({ adapters, profileDir, companyId: runtime.companyId, version: CLI_VERSION });
  openRunScope([], server.runId, { companyId: runtime.companyId, objective: "mcp session", surface: MCP_SURFACE_NAME });
  let closed = false;
  return {
    ...server,
    close: async () => {
      if (closed) return;
      closed = true;
      closeRunScope([], server.runId);
      await server.close();
    },
  };
}

export const mcpServeSpec: CommandSpec = {
  name: "serve",
  description: "Serve this profile's toolsets to MCP clients: stdio by default, or Streamable HTTP with --http",
  options: [
    { flags: "--stdio", description: "Speak MCP over this process's stdin and stdout (the default)" },
    { flags: "--http", description: "Bind a Streamable HTTP endpoint at /mcp instead of stdio" },
    { flags: "--host <host>", description: "Interface to bind with --http; a non-loopback host requires a bearer token", defaultValue: MCP_DEFAULT_HOST },
    { flags: "--port <port>", description: "Port to bind with --http", defaultValue: String(MCP_DEFAULT_PORT) },
    { flags: "--token-env <name>", description: `Environment variable holding the bearer token clients must present (default ${MCP_TOKEN_ENV})` },
  ],
  async run(ctx, opts) {
    const options = readOptions(opts);
    const explicitTokenEnv = typeof opts.tokenEnv === "string" && opts.tokenEnv !== "";
    if (ctx.dryRun) {
      const authenticated = process.env[options.tokenEnv] !== undefined && process.env[options.tokenEnv] !== "";
      return { data: { dryRun: true, command: "mcp serve", transport: options.transport, host: options.host, port: options.port, tokenEnv: options.tokenEnv, authenticated } };
    }
    const token = options.transport === "http" ? readToken(ctx, options, explicitTokenEnv) : undefined;

    const runtime = await openRuntime(ctx);
    const profileDir = ctx.config().getProfileDir();
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await runtime.cleanup();
    };
    const adapters = adaptersOf(runtime);

    if (options.transport === "stdio") {
      const server = connection(runtime, profileDir, adapters);
      releaseOnSignal(async () => {
        await server.close();
        await release();
      }, ctx.overrides.signals);
      try {
        await serveStdio(server);
      } finally {
        await server.close().catch(() => undefined);
        await release();
      }
      return { data: { server: "mcp", transport: "stdio", tools: server.catalog.map((tool) => tool.name), closed: true } };
    }

    const http = createMcpHttpServer({
      host: options.host,
      port: options.port,
      ...(token === undefined ? {} : { token }),
      createServer: () => connection(runtime, profileDir, adapters),
      log: (event, fields) => ctx.err(`${event} ${JSON.stringify(fields)}`),
    });
    try {
      await http.start();
    } catch (error) {
      await release();
      throw error;
    }
    releaseOnSignal(async () => {
      await http.stop();
      await release();
    }, ctx.overrides.signals);
    const catalog = createTrentMcpServer({ adapters, profileDir, companyId: runtime.companyId }).catalog;
    return {
      data: { server: "mcp", ...http.describe(), listening: true, tokenEnv: options.tokenEnv, tools: catalog.map((tool) => tool.name) },
      keepAlive: true,
    };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; transport?: string; host?: string; port?: number; path?: string; authenticated?: boolean; tools?: string[]; closed?: boolean };
    if (d.dryRun === true) {
      return [`  ${ctx.theme.meta(`would serve MCP over ${String(d.transport)}`)}${d.transport === "http" ? ` ${ctx.theme.value(`${String(d.host)}:${String(d.port)}`)}` : ""}`];
    }
    if (d.transport === "stdio") return [`  ${ctx.theme.meta("mcp stdio session closed")} ${ctx.theme.meta(`${String(d.tools?.length ?? 0)} tool(s) were served`)}`];
    return [
      `  ${ctx.theme.success("mcp listening")} ${ctx.theme.value(`http://${String(d.host)}:${String(d.port)}${String(d.path)}`)} ${ctx.theme.meta(d.authenticated === true ? "bearer required" : "no token: anyone on this machine may call")}`,
      `  ${ctx.theme.meta(`${String(d.tools?.length ?? 0)} tool(s); Ctrl+C to stop`)}`,
    ];
  },
};
