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
 * only, unless `--allow-flagged` is given, in which case the findings are stored on the entry
 * itself as `flagged` (tool and categories, never the matched text) and a warning goes to stderr.
 * The entry also records `scanRan`, so a server that could not be reached at add time is visibly
 * unchecked; the result says so too.
 *
 * `serve` is the other direction, Trent AS an MCP server; it lives in `mcp-serve.ts` (U5).
 *
 * [H2] OAuth 2.1 (MCP authorization 2026-07-28, `@trent/core/tools/mcp/http-oauth.ts`): `add --url ...
 * --oauth` runs the browser login BEFORE anything is written and stores the entry with the reference
 * `Authorization: Bearer ${MCP_<NAME>_ACCESS_TOKEN}`; the tokens go to the profile secrets file. `test
 * <name> --oauth` logs in again (an expired token, a new server) and converts an entry that sends no
 * Authorization of its own. `list` shows each OAuth server as connected, expired or needs-login, and
 * `remove` drops its stored OAuth state with it. Flags, not subcommands: the command count stays put.
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
import { mcpServeSpec } from "./mcp-serve.js";
// [H2]
import { loginMcpServer, type McpLoginResult } from "@trent/core/tools/mcp/http-oauth.js";
import { isMcpOAuthEntry, mcpOAuthEnvPrefix, mcpOAuthHeaderTemplate, McpOAuthStore, type McpAuthState } from "@trent/core/tools/mcp/http-oauth-store.js";
import type { OAuthFetch } from "@trent/core/tools/mcp/http-oauth-wire.js";
import type { LookupFn } from "@trent/core/tools/web/url-safety.js";
import { openBrowser } from "../web-server.js";

export const MCP_CONFIG_KEY = "mcp_servers";
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token"]);

function fail(operation: string, message: string, target?: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, ...(target === undefined ? {} : { target }) });
}

// [H2] What the OAuth login reaches outside itself. Replaced in tests; there is no other way in.
export interface McpCliDeps {
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly fetchImpl?: OAuthFetch;
  readonly lookup?: LookupFn;
  readonly timeoutMs?: number;
}

let depsOverride: McpCliDeps | null = null;

/** Test seam. `null` restores the browser, the process fetch and DNS. */
export function setMcpDeps(deps: McpCliDeps | null): void {
  depsOverride = deps;
}

function oauthStore(ctx: CommandContext): McpOAuthStore {
  return new McpOAuthStore(ctx.config());
}

function hasOwnAuthorization(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === "authorization");
}

function runLogin(ctx: CommandContext, name: string, url: string): Promise<McpLoginResult> {
  const deps = depsOverride ?? {};
  return loginMcpServer(name, url, {
    store: oauthStore(ctx),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.lookup === undefined ? {} : { lookup: deps.lookup }),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    openBrowser: deps.openBrowser ?? openBrowser,
    // The URL carries the client id, the state and the PKCE challenge; none of them is a secret.
    onAuthorizationUrl: (url) => ctx.err(`opening the browser to authorize MCP server ${name}; if it did not open, visit: ${url}`),
  });
}

/** Two names that differ only by `-` and `_` would share one set of secret names. */
function refuseSharedOAuthNames(ctx: CommandContext, name: string, operation: string): void {
  const prefix = mcpOAuthEnvPrefix(name);
  const clash = Object.keys(readServers(ctx)).find((other) => other !== name && mcpOAuthEnvPrefix(other) === prefix);
  if (clash !== undefined) fail(operation, `${name} and ${clash} would share the secret names ${prefix}_*; pick a name that differs by more than - and _`, name);
}

interface AuthView {
  readonly auth: McpAuthState;
  readonly refreshable: boolean;
  readonly expiresAt?: string;
}

function authOf(ctx: CommandContext, name: string, entry: McpServerConfig): AuthView | undefined {
  if (entry.transport !== "http" || !isMcpOAuthEntry(name, entry.headers)) return undefined;
  const status = oauthStore(ctx).status(name, new Date());
  return { auth: status.state, refreshable: status.refreshable, ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }) };
}

function renderAuth(view: AuthView | undefined): string {
  if (view === undefined) return "";
  if (view.auth === "expired") return ` oauth: expired${view.refreshable ? ", renews on next connect" : ""}`;
  return ` oauth: ${view.auth}`;
}

function renderLogin(login: McpLoginResult | undefined, ctx: CommandContext): string[] {
  if (login === undefined) return [];
  return [
    `  ${ctx.theme.success("logged in")} ${ctx.theme.value(login.server)} ${ctx.theme.meta(`issuer ${login.issuer}, ${login.registration === "dynamic" ? "client registered" : "registered client reused"}`)}`,
    `  ${ctx.theme.meta("written")}  ${ctx.theme.body(login.written.join(", "))} ${ctx.theme.meta("(profile secrets file, 0600)")}`,
  ];
}
// [/H2]

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

function buildEntry(opts: Record<string, unknown>, name: string): McpServerConfig {
  const command = typeof opts.command === "string" ? opts.command : undefined;
  const url = typeof opts.url === "string" ? opts.url : undefined;
  if (command && url) fail("mcp.add", "give either --command (stdio) or --url (http), not both");
  if (!command && !url) fail("mcp.add", "give --command <cmd> for a stdio server or --url <url> for an http server");
  const env = pairs(strings(opts.env), "--env");
  const headers = pairs(strings(opts.header), "--header");
  // [H2] --oauth writes the one reference itself; a second credential would be ambiguous.
  const oauth = opts.oauth === true;
  if (oauth && !url) fail("mcp.add", "--oauth is for an http server; give --url");
  if (oauth && hasOwnAuthorization(headers)) fail("mcp.add", "--oauth supplies the Authorization header itself; drop --header Authorization=...", "Authorization");
  refuseLiteralSecrets(env, headers);
  const common = { auto_approve: strings(opts.autoApprove), enabled: true };
  const raw = command
    ? { transport: "stdio", command, args: strings(opts.args), env, ...common }
    : { transport: "http", url, headers: oauth ? { ...headers, Authorization: mcpOAuthHeaderTemplate(name) } : headers, ...common };
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (!parsed.success) fail("mcp.add", parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`).join("; "));
  return parsed.data;
}

function target(entry: McpServerConfig): string {
  return entry.transport === "stdio" ? entry.command : entry.url;
}

function isFlagged(entry: McpServerConfig): boolean {
  return entry.flagged !== undefined && entry.flagged.length > 0;
}

interface ScanOutcome {
  readonly scanRan: boolean;
  readonly reason?: string;
  readonly findings: McpScanFinding[];
}

/** Connects once, lists the tools and scans them. Unreachable is an outcome, not an error. */
async function scanAtAdd(name: string, entry: McpServerConfig, store: McpOAuthStore): Promise<ScanOutcome> {
  let connection;
  try {
    connection = await connectMcpServer(name, entry, { env: process.env, oauth: { store } });
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
                return { name, transport: entry.transport, target: target(entry), auto_approve: entry.auto_approve, enabled: entry.enabled, ...(isFlagged(entry) ? { flagged: true } : {}), ...(authOf(ctx, name, entry) ?? {}) };
              }),
            available: MCP_CONNECTOR_GALLERY.map((t) => ({ id: t.id, name: t.name, source: t.source, transport: t.transport, auth: t.authMode })),
          },
        };
      },
      render(data, ctx) {
        const d = data as { configured: ({ name: string; transport: string; target: string; enabled: boolean; flagged?: boolean } & Partial<AuthView>)[]; available: { id: string; name: string; source: string }[] };
        const lines = [ctx.theme.emphasis(`MCP SERVERS (${d.configured.length} configured)`)];
        for (const s of d.configured) {
          const auth = s.auth === undefined ? undefined : { auth: s.auth, refreshable: s.refreshable === true };
          lines.push(`  ${s.enabled ? ctx.theme.success("on ") : ctx.theme.meta("off")} ${ctx.theme.value(s.name.padEnd(20, " "))} ${ctx.theme.meta(s.transport)} ${ctx.theme.body(s.target)}${s.flagged ? ` ${ctx.theme.meta("flagged by the install-time scan")}` : ""}${auth === undefined ? "" : ctx.theme.meta(renderAuth(auth))}`);
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
        { flags: "--oauth", description: "http: log in with OAuth 2.1 in the browser (discovery, registration, PKCE); tokens go to the profile secrets file" },
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
            entry = buildEntry(opts, name);
          } catch (error) {
            problems.push(error instanceof Error ? error.message : String(error));
          }
          return { data: { dryRun: true, command: "mcp add", name, transport: entry?.transport ?? null, target: entry ? target(entry) : null, ...(opts.oauth === true ? { auth: "oauth" } : {}), problems } };
        }
        if (!MCP_SERVER_NAME_PATTERN.test(name)) fail("mcp.add", `server name must match ${MCP_SERVER_NAME_PATTERN}`, name);
        if (isBuiltinToolName(name)) fail("mcp.add", "name collides with a built-in Trent tool", name);
        const entry = buildEntry(opts, name);
        const manager = ctx.config();
        if (readServers(ctx)[name]) fail("mcp.add", "a server with that name is already configured", name);
        // [H2] The login runs before anything is written: a failed login leaves no entry behind.
        const oauth = opts.oauth === true && entry.transport === "http";
        if (oauth) refuseSharedOAuthNames(ctx, name, "mcp.add");
        const login = oauth ? await runLogin(ctx, name, entry.url) : undefined;
        const scan = await scanAtAdd(name, entry, oauthStore(ctx));
        const flagged = scan.findings.length > 0;
        if (flagged && opts.allowFlagged !== true) {
          if (login !== undefined) oauthStore(ctx).remove(name);
          throw new TrentError({
            code: EXIT.CONFIG,
            operation: "mcp.add",
            message: `the security scan flagged tool(s) on this server: ${describeFindings(scan.findings)}; pass --allow-flagged to install it anyway`,
            target: name,
            context: { findings: scan.findings },
          });
        }
        manager.set(`${MCP_CONFIG_KEY}.${name}`, { ...entry, scanRan: scan.scanRan, ...(flagged ? { flagged: scan.findings } : {}) });
        if (flagged) ctx.err(`warning: ${name} is installed flagged; the scan found ${describeFindings(scan.findings)}`);
        return {
          data: {
            added: { name, transport: entry.transport, target: target(entry), auto_approve: entry.auto_approve, scanRan: scan.scanRan, ...(scan.reason === undefined ? {} : { scanReason: scan.reason }), flagged, findings: scan.findings, ...(login === undefined ? {} : { auth: "oauth" }) },
            ...(login === undefined ? {} : { login }),
            count: Object.keys(readServers(ctx)).length,
          },
        };
      },
      render(data, ctx) {
        const d = data as { added?: { name: string; transport: string; scanRan: boolean; scanReason?: string; flagged: boolean }; login?: McpLoginResult; dryRun?: boolean; name?: string; problems?: string[] };
        if (d.dryRun === true) {
          return d.problems?.length ? d.problems.map((p) => `  ${ctx.theme.meta("would refuse")} ${String(d.name)}: ${p}`) : [`  ${ctx.theme.meta("would add")} ${String(d.name)}`];
        }
        const scan = d.added?.flagged ? "flagged by the security scan" : d.added?.scanRan ? "tool descriptions checked, clean" : `scan did not run: ${d.added?.scanReason ?? "unreachable"}`;
        return [...renderLogin(d.login, ctx), `  ${ctx.theme.success("added")} ${ctx.theme.value(String(d.added?.name))} ${ctx.theme.meta(String(d.added?.transport))} ${ctx.theme.meta(scan)}`];
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
        // [H2] A removed server's OAuth client and tokens do not outlive it.
        const oauthRemoved = oauthStore(ctx).remove(name);
        return { data: { removed: name, count: Object.keys(readServers(ctx)).length, ...(oauthRemoved.length > 0 ? { oauthRemoved } : {}) } };
      },
      render(data, ctx) {
        const d = data as { removed: string; oauthRemoved?: string[] };
        return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.removed)}${d.oauthRemoved === undefined ? "" : ctx.theme.meta(` and its OAuth state (${d.oauthRemoved.length} secret name(s))`)}`];
      },
    },
    {
      name: "test <name>",
      description: "Connect to a configured MCP server and list the tools it exposes; --oauth logs in first",
      options: [{ flags: "--oauth", description: "http: run the OAuth 2.1 browser login first (renews an expired login, or converts an entry with no Authorization header)" }],
      async run(ctx, opts, args) {
        const name = String(args[0]);
        let entry = readServers(ctx)[name];
        if (ctx.dryRun) return { data: { dryRun: true, command: "mcp test", name, configured: entry !== undefined, ...(opts.oauth === true ? { oauth: true } : {}) } };
        if (!entry) fail("mcp.test", "no server with that name is configured", name);
        // [H2] The login, then the same connect as without the flag.
        let login: McpLoginResult | undefined;
        if (opts.oauth === true) {
          if (entry.transport !== "http") fail("mcp.test", "--oauth is for an http server; this one is stdio", name);
          const managed = isMcpOAuthEntry(name, entry.headers);
          if (!managed && hasOwnAuthorization(entry.headers)) fail("mcp.test", "the entry sends its own Authorization header; remove the server and add it again with --oauth", name);
          if (!managed) refuseSharedOAuthNames(ctx, name, "mcp.test");
          login = await runLogin(ctx, name, entry.url);
          if (!managed) {
            ctx.config().set(`${MCP_CONFIG_KEY}.${name}`, { ...entry, headers: { ...entry.headers, Authorization: mcpOAuthHeaderTemplate(name) } });
            entry = readServers(ctx)[name]!;
          }
        }
        const withLogin = login === undefined ? {} : { login };
        try {
          const connection = await connectMcpServer(name, entry, { env: process.env, oauth: { store: oauthStore(ctx) } });
          try {
            const listed = await connection.listTools();
            const tools = listed.map((t) => mcpToolName(name, t.name));
            return { data: { name, ok: true, transport: entry.transport, tools, findings: scanMcpTools(listed), ...withLogin } };
          } finally {
            await connection.close();
          }
        } catch (error) {
          return { data: { name, ok: false, transport: entry.transport, tools: [], reason: connectFailureReason(error), ...withLogin }, exitCode: EXIT.CONFIG };
        }
      },
      render(data, ctx) {
        const d = data as { name: string; ok: boolean; tools: string[]; findings?: McpScanFinding[]; reason?: string; login?: McpLoginResult };
        if (!d.ok) return [...renderLogin(d.login, ctx), `  ${ctx.theme.meta("unavailable")} ${ctx.theme.value(d.name)}: ${d.reason ?? ""}`];
        const lines = [...renderLogin(d.login, ctx), `  ${ctx.theme.success("connected")} ${ctx.theme.value(d.name)} ${ctx.theme.meta(`${d.tools.length} tool(s)`)}`, ...d.tools.map((t) => `    ${t}`)];
        if (d.findings?.length) lines.push(`  ${ctx.theme.meta("security scan flagged")} ${describeFindings(d.findings)}`);
        return lines;
      },
    },
    mcpServeSpec,
  ],
};
