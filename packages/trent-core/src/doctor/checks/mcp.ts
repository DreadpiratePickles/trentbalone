import fs from "node:fs";
import path from "node:path";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHttp, runCommand } from "../probe.js";
import type { McpServersConfig } from "../../config/schema.js";
import { isMcpOAuthEntry, McpOAuthStore } from "../../tools/mcp/http-oauth-store.js";

/**
 * This check used to return a hard-coded green sentence about a "marketplace" from inside a try
 * block that could not throw. It now reads the declared servers and contacts each one.
 */

const CATEGORY = "MCP";
const NAME = "MCP Connectors";

interface McpServer {
  url?: string;
  command?: string;
}

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/** Servers come from `<profile>/mcp.json`, or from an `mcp.servers` block in config.yaml. */
export function loadMcpServers(ctx: DoctorContext): {
  servers: Record<string, McpServer>;
  source: string;
  parseError?: string;
} {
  const file = path.join(path.dirname(ctx.configManager.getConfigPath()), "mcp.json");
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { servers?: Record<string, McpServer> };
      return { servers: parsed.servers ?? {}, source: file };
    } catch (err) {
      return { servers: {}, source: file, parseError: (err as Error).message };
    }
  }

  const config = ctx.configManager.loadConfig() as unknown as {
    mcp?: { servers?: Record<string, McpServer> };
  };
  return { servers: config.mcp?.servers ?? {}, source: ctx.configManager.getConfigPath() };
}

// [H2] OAuth-managed `mcp_servers` entries whose token needs a person: expired with nothing to renew
// it, or never logged in. Names, expiries and commands only; a token never reaches a message.
interface OAuthFindings {
  readonly lines: string[];
  readonly commands: string[];
}

function oauthFindings(ctx: DoctorContext): OAuthFindings {
  const found: OAuthFindings = { lines: [], commands: [] };
  let servers: McpServersConfig;
  try {
    servers = ctx.configManager.loadConfig().mcp_servers ?? {};
  } catch {
    return found;
  }
  const store = new McpOAuthStore(ctx.configManager);
  for (const [name, entry] of Object.entries(servers)) {
    if (entry.transport !== "http" || !entry.enabled || !isMcpOAuthEntry(name, entry.headers)) continue;
    const status = store.status(name, new Date());
    if (status.state === "needs-login") found.lines.push(`${name} (OAuth: never logged in)`);
    else if (status.state === "expired" && !status.refreshable) found.lines.push(`${name} (OAuth token expired at ${status.expiresAt ?? "an unknown time"}, no refresh token)`);
    else continue;
    found.commands.push(status.login);
  }
  return found;
}

function withOAuth(base: CheckResult, found: OAuthFindings): CheckResult {
  if (found.lines.length === 0) return base;
  const note = `MCP OAuth login needed: ${found.lines.join(", ")}.`;
  const fix = `Run ${found.commands.join(" and ")}.`;
  return {
    ...base,
    status: base.status === "fail" ? "fail" : "warn",
    message: base.status === "skip" ? note : `${base.message} ${note}`,
    fixHint: base.fixHint === undefined ? fix : `${base.fixHint} ${fix}`,
    details: { ...(base.details ?? {}), oauthLoginNeeded: found.lines.map((line) => line.split(" ")[0]) },
  };
}
// [/H2]

async function commandExists(ctx: DoctorContext, command: string, timeoutMs: number): Promise<boolean> {
  const exec = ctx.execImpl ?? runCommand;
  try {
    const out = await exec("/usr/bin/env", ["which", command], timeoutMs);
    return out.code === 0;
  } catch {
    return false;
  }
}

const checkMcpReachability: DoctorCheck = {
  id: "check_mcp",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const { servers, source, parseError } = loadMcpServers(ctx);

    if (parseError) {
      return result({
        status: "fail",
        message: `MCP server definitions at ${source} could not be parsed: ${parseError}`,
        fixHint: `Fix the JSON syntax in ${source}, or delete the file to run without MCP servers.`,
        details: { source },
      });
    }

    const names = Object.keys(servers);
    if (names.length === 0) {
      return result({
        status: "skip",
        message: "No MCP servers are declared, so none were contacted.",
        details: { source },
      });
    }

    const reachable: string[] = [];
    const failures: string[] = [];

    for (const name of names) {
      const server = servers[name] as McpServer;
      if (server.url) {
        const probe = await probeHttp(
          server.url,
          { method: "GET", headers: { accept: "text/event-stream" } },
          { fetchImpl: ctx.fetchImpl, timeoutMs },
        );
        if (probe.kind === "response" && probe.response.status < 500) reachable.push(name);
        else failures.push(`${name} (${probe.kind === "timeout" ? "timed out" : "unreachable"})`);
      } else if (server.command) {
        if (await commandExists(ctx, server.command, timeoutMs)) reachable.push(name);
        else failures.push(`${name} (command not found)`);
      } else {
        failures.push(`${name} (no url and no command declared)`);
      }
    }

    if (failures.length > 0) {
      return result({
        status: "fail",
        message: `${failures.length} of ${names.length} MCP server(s) did not answer: ${failures.join(", ")}.`,
        fixHint: `Start the server, or remove its entry from ${source}.`,
        details: { source, reachable, failures },
      });
    }

    return result({
      status: "ok",
      message: `${reachable.length} MCP server(s) answered: ${reachable.join(", ")}.`,
      details: { source, reachable },
    });
  },
};

// [H2] The same check, with the OAuth findings folded into its line.
export const checkMcp: DoctorCheck = {
  ...checkMcpReachability,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    return withOAuth(await checkMcpReachability.run(ctx), oauthFindings(ctx));
  },
};
