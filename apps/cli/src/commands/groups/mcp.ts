/**
 * The `mcp` group: `trent mcp list|add|remove|test <name>` over the `mcp_servers` config block.
 *
 * `add` validates through the same zod schema the toolset reads, refuses a name that would shadow
 * a built-in tool, and refuses a literal secret: an env var whose NAME looks secret, or a header
 * such as `Authorization`, must carry a `${ENV_VAR}` reference, which is stored as written and
 * resolved only at connect time. `test` speaks the real protocol and lists the tools it found;
 * its failure reason names variables and hosts, never values.
 *
 * Install-time scan (T3.3): when the server answers at add time, its tool list is run through the
 * skill security scan (`scanMcpTools`). A finding refuses the add, naming tools and categories
 * only, unless `--allow-flagged` is given, in which case the server is recorded under the
 * top-level `mcp_flagged` key (name -> findings, categories only) and a warning goes to stderr.
 * The flag lives beside `mcp_servers` rather than inside the entry because the entry schema strips
 * unknown keys on every save. A server that cannot be reached at add time is stored unchecked
 * and the result says so.
 */
import process from "node:process";
import { MCP_CONNECTOR_GALLERY } from "@trent/core/mcp/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { McpServerConfigSchema, McpServersConfigSchema, MCP_SERVER_NAME_PATTERN, type McpServerConfig, type McpServersConfig } from "@trent/core/config/index.js";
import { isSecretName } from "@trent/core/terminal/env-scrub.js";
import { isBuiltinToolName } from "@trent/core/tools/tool-names.js";
import { connectFailureReason, connectMcpServer, containsTemplate, mcpToolName, scanMcpTools, type McpScanFinding } from "@trent/core/tools/mcp/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";

export const MCP_CONFIG_KEY = "mcp_servers";
/** Top-level, passthrough: `{ <server>: McpScanFinding[] }` for servers installed with `--allow-flagged`. */
export const MCP_FLAGGED_KEY = "mcp_flagged";
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token"]);

function fail(operation: string, message: string, target?: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, ...(target === undefined ? {} : { target }) });
}

function readServers(ctx: CommandContext): McpServersConfig {
  const parsed = McpServersConfigSchema.safeParse(ctx.config().get(MCP_CONFIG_KEY) ?? {});
  return parsed.success ? parsed.data : {};
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? [value] : [];
}

/** `NAME=value` pairs; the value may contain `=`. */
function pairs(values: string[], what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf("=");
    if (eq <= 0) fail("mcp.add", `${what} must be NAME=value`, raw.split("=")[0]);
    out[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return out;
}

function refuseLiteralSecrets(env: Record<string, string>, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (isSecretName(name) && !containsTemplate(value)) {
      fail("mcp.add", "env value looks like a secret; write it as ${ENV_VAR} and export the variable instead", name);
    }
  }
  for (const [name, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(name.toLowerCase()) && !containsTemplate(value)) {
      fail("mcp.add", "header carries a credential; write it as ${ENV_VAR} and export the variable instead", name);
    }
  }
}

function buildEntry(opts: Record<string, unknown>): McpServerConfig {
  const command = typeof opts.command === "string" ? opts.command : undefined;
  const url = typeof opts.url === "string" ? opts.url : undefined;
  if (command && url) fail("mcp.add", "give either --command (stdio) or --url (http), not both");
  if (!command && !url) fail("mcp.add", "give --command <cmd> for a stdio server or --url <url> for an http server");
  const env = pairs(strings(opts.env), "--env");
  const headers = pairs(strings(opts.header), "--header");
  refuseLiteralSecrets(env, headers);
  const common = { auto_approve: strings(opts.autoApprove), enabled: true };
  const raw = command
    ? { transport: "stdio", command, args: strings(opts.args), env, ...common }
    : { transport: "http", url, headers, ...common };
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success) fail("mcp.add", parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; "));
  return parsed.data;
}

function target(entry: McpServerConfig): string {
  return entry.transport === "stdio" ? entry.command : entry.url;
}

function isFlagged(ctx: CommandContext, name: string): boolean {
  return Array.isArray(ctx.config().get(`${MCP_FLAGGED_KEY}.${name}`));
}

interface ScanOutcome {
  readonly scanRan: boolean;
  readonly reason?: string;
  readonly findings: McpScanFinding[];
}

/** Connects once, lists the tools and scans them. Unreachable is an outcome, not an error. */
async function scanAtAdd(name: string, entry: McpServerConfig): Promise<ScanOutcome> {
  let connection;
  try {
    connection = await connectMcpServer(name, entry, { env: process.env });
  } catch (error) {
    return { scanRan: false, reason: connectFailureReason(error), findings: [] };
  }
  try {
    return { scanRan: true, findings: scanMcpTools(await connection.listTools()) };
  } catch (error) {
    return { scanRan: false, reason: `tools/list failed: ${connectFailureReason(error)}`, findings: [] };
  } finally {
    await connection.close();
  }
}

function describeFindings(findings: readonly McpScanFinding[]): string {
  return findings.map((f) => `${f.tool} [${f.categories.join("; ")}]`).join(", ");
}

export const mcpSpec: CommandSpec = {
  name: "mcp",
  description: "Manage Model Context Protocol servers (config key mcp_servers)",
  subcommands: [
    {
      name: "list",
      description: "List configured MCP servers and the vetted connector gallery",
      run(ctx) {
        const servers = readServers(ctx);
        return {
          data: {
            configured: Object.keys(servers)
              .sort()
              .map((name) => {
                const entry = servers[name]!;
                return { name, transport: entry.transport, target: target(entry), auto_approve: entry.auto_approve, enabled: entry.enabled, ...(isFlagged(ctx, name) ? { flagged: true } : {}) };
              }),
            available: MCP_CONNECTOR_GALLERY.map((t) => ({ id: t.id, name: t.name, source: t.source, transport: t.transport, auth: t.authMode })),
          },
        };
      },
      render(data, ctx) {
        const d = data as { configured: { name: string; transport: string; target: string; enabled: boolean; flagged?: boolean }[]; available: { id: string; name: string; source: string }[] };
        const lines = [ctx.theme.emphasis(`MCP SERVERS (${d.configured.length} configured)`)];
        for (const s of d.configured) {
          lines.push(`  ${s.enabled ? ctx.theme.success("on ") : ctx.theme.meta("off")} ${ctx.theme.value(s.name.padEnd(20, " "))} ${ctx.theme.meta(s.transport)} ${ctx.theme.body(s.target)}${s.flagged ? ` ${ctx.theme.meta("flagged by the install-time scan")}` : ""}`);
        }
        if (d.configured.length === 0) lines.push(ctx.theme.meta("  none; trent mcp add <name> --command <cmd> [--args ...] | --url <url>"));
        lines.push(ctx.theme.emphasis(`GALLERY (${d.available.length})`));
        for (const t of d.available) lines.push(`  ${ctx.theme.value(t.id.padEnd(22, " "))} ${ctx.theme.body(t.name)} ${ctx.theme.meta(t.source)}`);
        return lines;
      },
    },
    {
      name: "add <name>",
      description: "Add an MCP server: --command for stdio, --url for http; env and header values may use ${ENV_VAR}",
      options: [
        { flags: "--command <command>", description: "stdio: the executable to spawn" },
        { flags: "--args <args...>", description: "stdio: arguments for the executable" },
        { flags: "--env <pairs...>", description: "stdio: NAME=value passed to the child; secrets as NAME=${ENV_VAR}" },
        { flags: "--url <url>", description: "http: the server endpoint (goes through the egress proxy)" },
        { flags: "--header <pairs...>", description: "http: Name=value request headers; credentials as ${ENV_VAR}" },
        { flags: "--auto-approve <tools...>", description: "Tools (server's own names) that may run without approval" },
        { flags: "--allow-flagged", description: "Install even when the security scan flags a tool description; the entry is stored as flagged" },
      ],
      async run(ctx, opts, args) {
        const name = String(args[0]);
        if (ctx.dryRun) {
          // Reports instead of throwing: `--dry-run` must always answer with JSON and exit 0.
          const problems: string[] = [];
          if (!MCP_SERVER_NAME_PATTERN.test(name)) problems.push(`server name must match ${MCP_SERVER_NAME_PATTERN}`);
          if (isBuiltinToolName(name)) problems.push("name collides with a built-in Trent tool");
          let entry: McpServerConfig | undefined;
          try {
            entry = buildEntry(opts);
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
          return { data: { dryRun: true, command: "mcp add", name, transport: entry?.transport ?? null, target: entry ? target(entry) : null, problems } };
        }
        if (!MCP_SERVER_NAME_PATTERN.test(name)) fail("mcp.add", `server name must match ${MCP_SERVER_NAME_PATTERN}`, name);
        if (isBuiltinToolName(name)) fail("mcp.add", "name collides with a built-in Trent tool", name);
        const entry = buildEntry(opts);
        const manager = ctx.config();
        if (readServers(ctx)[name]) fail("mcp.add", "a server with that name is already configured", name);
        const scan = await scanAtAdd(name, entry);
        const flagged = scan.findings.length > 0;
        if (flagged && opts.allowFlagged !== true) {
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "mcp.add",
            message: `the security scan flagged tool(s) on this server: ${describeFindings(scan.findings)}; pass --allow-flagged to install it anyway`,
            target: name,
            context: { findings: scan.findings },
          });
        }
        manager.set(`${MCP_CONFIG_KEY}.${name}`, entry);
        if (flagged) manager.set(`${MCP_FLAGGED_KEY}.${name}`, scan.findings);
        if (flagged) ctx.err(`warning: ${name} is installed flagged; the scan found ${describeFindings(scan.findings)}`);
        return {
          data: {
            added: { name, transport: entry.transport, target: target(entry), auto_approve: entry.auto_approve, scanRan: scan.scanRan, ...(scan.reason === undefined ? {} : { scanReason: scan.reason }), flagged, findings: scan.findings },
            count: Object.keys(readServers(ctx)).length,
          },
        };
      },
      render(data, ctx) {
        const d = data as { added?: { name: string; transport: string; scanRan: boolean; scanReason?: string; flagged: boolean }; dryRun?: boolean; name?: string; problems?: string[] };
        if (d.dryRun === true) {
          return d.problems?.length ? d.problems.map((p) => `  ${ctx.theme.meta("would refuse")} ${String(d.name)}: ${p}`) : [`  ${ctx.theme.meta("would add")} ${String(d.name)}`];
        }
        const scan = d.added?.flagged ? "flagged by the security scan" : d.added?.scanRan ? "tool descriptions checked, clean" : `scan did not run: ${d.added?.scanReason ?? "unreachable"}`;
        return [`  ${ctx.theme.success("added")} ${ctx.theme.value(String(d.added?.name))} ${ctx.theme.meta(String(d.added?.transport))} ${ctx.theme.meta(scan)}`];
      },
    },
    {
      name: "remove <name>",
      description: "Remove a configured MCP server",
      run(ctx, _opts, args) {
        const name = String(args[0]);
        if (ctx.dryRun) return { data: { dryRun: true, command: "mcp remove", name } };
        if (!readServers(ctx)[name]) fail("mcp.remove", "no server with that name is configured", name);
        ctx.config().delete(`${MCP_CONFIG_KEY}.${name}`);
        if (isFlagged(ctx, name)) ctx.config().delete(`${MCP_FLAGGED_KEY}.${name}`);
        return { data: { removed: name, count: Object.keys(readServers(ctx)).length } };
      },
      render(data, ctx) {
        const d = data as { removed: string };
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.removed)}`];
      },
    },
    {
      name: "test <name>",
      description: "Connect to a configured MCP server and list the tools it exposes",
      async run(ctx, _opts, args) {
        const name = String(args[0]);
        const entry = readServers(ctx)[name];
        if (ctx.dryRun) return { data: { dryRun: true, command: "mcp test", name, configured: entry !== undefined } };
        if (!entry) fail("mcp.test", "no server with that name is configured", name);
        try {
          const connection = await connectMcpServer(name, entry, { env: process.env });
          try {
            const listed = await connection.listTools();
            const tools = listed.map((t) => mcpToolName(name, t.name));
            return { data: { name, ok: true, transport: entry.transport, tools, findings: scanMcpTools(listed) } };
          } finally {
            await connection.close();
          }
        } catch (error) {
          return { data: { name, ok: false, transport: entry.transport, tools: [], reason: connectFailureReason(error) }, exitCode: EXIT.CONFIG };
        }
      },
      render(data, ctx) {
        const d = data as { name: string; ok: boolean; tools: string[]; findings?: McpScanFinding[]; reason?: string };
        if (!d.ok) return [`  ${ctx.theme.meta("unavailable")} ${ctx.theme.value(d.name)}: ${d.reason ?? ""}`];
        const lines = [`  ${ctx.theme.success("connected")} ${ctx.theme.value(d.name)} ${ctx.theme.meta(`${d.tools.length} tool(s)`)}`, ...d.tools.map((t) => `    ${t}`)];
        if (d.findings?.length) lines.push(`  ${ctx.theme.meta("security scan flagged")} ${describeFindings(d.findings)}`);
        return lines;
      },
    },
  ],
};
