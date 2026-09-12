import fs from "node:fs";
import path from "node:path";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import { DEFAULT_PROBE_TIMEOUT_MS, probeHttp, runCommand } from "../probe.js";

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

async function commandExists(ctx: DoctorContext, command: string, timeoutMs: number): Promise<boolean> {
  const exec = ctx.execImpl ?? runCommand;
  try {
    const out = await exec("/usr/bin/env", ["which", command], timeoutMs);
    return out.code === 0;
  } catch {
    return false;
  }
}

export const checkMcp: DoctorCheck = {
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
