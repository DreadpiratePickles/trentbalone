/**
 * The `connect` group: `trent connect <provider>|list|remove|refresh`.
 *
 * The credential flow the business, media and social toolsets execute against real accounts
 * with. An API key or a basic pair is prompted hidden (or read from the environment with
 * `--from-env`); an OAuth provider runs the loopback flow in `@trent/core/connect`. Every value
 * lands in the profile secrets file at 0600 through the one store, and every payload a handler
 * returns is a `ConnectResult` or a `ConnectionRecord`: names, scopes, an expiry, never a value.
 *
 * The outside world (prompts, the browser, the token endpoints) is replaced through
 * `setConnectDeps`, the same module-level seam `workspace.ts` uses for its confirmation, so the
 * tests drive the whole surface against a local authorization server and scripted answers.
 */
import process from "node:process";
import {
  CONNECT_PROVIDERS,
  ConnectStore,
  connectFields,
  connectOAuth,
  connectProvider,
  isConnectProviderId,
  refreshOAuth,
  type ConnectProvider,
  type ConnectProviderId,
  type ConnectResult,
  type ConnectionRecord,
  type FetchLike,
  type OAuthEndpoints,
  type OAuthFlowDeps,
} from "@trent/core/connect/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { InquirerPrompts, type PromptPort } from "@trent/core/setup/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";
import { openBrowser } from "../web-server.js";

/** What the group reaches outside itself. Replaced in tests; there is no other way in. */
export interface ConnectDeps {
  readonly prompts?: PromptPort;
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly fetchImpl?: FetchLike;
  readonly endpoints?: Partial<Record<ConnectProviderId, OAuthEndpoints>>;
  readonly now?: () => Date;
  /** Whether a terminal can answer a prompt. Defaults to `process.stdin.isTTY`. */
  readonly interactive?: boolean;
}

let depsOverride: ConnectDeps | null = null;

/** Test seam. `null` restores the terminal, the browser and the real endpoints. */
export function setConnectDeps(deps: ConnectDeps | null): void {
  depsOverride = deps;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

function usage(operation: string, message: string, target?: string): TrentError {
  return new TrentError({ code: EXIT.USAGE, operation, message, ...(target === undefined ? {} : { target }) });
}

/** The provider an argument names, or the usage error that lists the ids. */
function providerArg(raw: unknown, operation: string): ConnectProvider {
  const id = String(raw ?? "").trim();
  if (!isConnectProviderId(id)) {
    throw usage(operation, `unknown provider "${id}"; known providers: ${CONNECT_PROVIDERS.map((p) => p.id).join(", ")}`, id);
  }
  return connectProvider(id);
}

function dryRun(command: string, raw: unknown): { data: Record<string, unknown> } {
  const id = String(raw ?? "").trim();
  const known = isConnectProviderId(id);
  return {
    data: {
      dryRun: true,
      command,
      provider: id,
      known,
      ...(known ? { kind: connectProvider(id).kind, envNames: connectProvider(id).fields.map((f) => f.env) } : {}),
    },
  };
}

function listing(ctx: CommandContext): { data: { command: string; providers: ConnectionRecord[] } } {
  return { data: { command: "connect", providers: new ConnectStore(ctx.config()).list() } };
}

/**
 * Collect the field values for an api_key or basic provider. `--from-env NAME` names the
 * variable holding the secret; a bare `--from-env` reads every field from its own env name;
 * `--username` supplies the identifier of a basic pair. Whatever is still missing is prompted,
 * hidden for a secret, and only when a terminal (or a scripted port) can answer.
 */
async function collectFields(provider: ConnectProvider, opts: Record<string, unknown>, deps: ConnectDeps): Promise<Record<string, string>> {
  const operation = `connect.${provider.id}`;
  const values: Record<string, string> = {};
  const fromEnv = opts.fromEnv;
  const username = typeof opts.username === "string" ? opts.username.trim() : "";

  for (const field of provider.fields) {
    if (!field.secret && username !== "") {
      values[field.env] = username;
      continue;
    }
    if (field.secret && typeof fromEnv === "string") {
      const value = process.env[fromEnv];
      if (value === undefined || value === "") throw usage(operation, `environment variable ${fromEnv} is not set`, fromEnv);
      values[field.env] = value;
      continue;
    }
    if (fromEnv === true) {
      const value = process.env[field.env];
      if (value === undefined || value === "") throw usage(operation, `environment variable ${field.env} is not set`, field.env);
      values[field.env] = value;
      continue;
    }
    if (!field.secret && typeof fromEnv === "string") {
      const own = process.env[field.env];
      if (own !== undefined && own !== "") {
        values[field.env] = own;
        continue;
      }
    }
    const interactive = deps.prompts !== undefined || (deps.interactive ?? process.stdin.isTTY === true);
    if (!interactive) {
      const hint = field.secret ? `pass --from-env NAME` : `pass --username <value>`;
      throw usage(operation, `nothing here can answer a prompt for ${field.env}; ${hint}`, field.env);
    }
    const prompts = deps.prompts ?? new InquirerPrompts();
    const id = `${provider.id}.${field.env}`;
    const answer = field.secret
      ? await prompts.password({ id, message: `${field.label} (input hidden)` })
      : await prompts.input({ id, message: field.label, default: "" });
    if (answer.trim() === "") throw usage(operation, `no value entered for ${field.env}`, field.env);
    values[field.env] = answer;
  }
  return values;
}

function timeoutMs(opts: Record<string, unknown>, operation: string): number {
  const seconds = Number(opts.timeout ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) throw usage(operation, "--timeout must be a positive number of seconds", String(opts.timeout));
  return seconds * 1000;
}

function portOf(opts: Record<string, unknown>, operation: string): number {
  if (opts.port === undefined) return 0;
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage(operation, "--port must be a port number", String(opts.port));
  return port;
}

function flowDeps(ctx: CommandContext, provider: ConnectProvider, opts: Record<string, unknown>, deps: ConnectDeps, operation: string): OAuthFlowDeps {
  const noBrowser = opts.browser === false;
  const open = deps.openBrowser ?? openBrowser;
  return {
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.endpoints?.[provider.id] === undefined ? {} : { endpoints: deps.endpoints[provider.id] }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    port: portOf(opts, operation),
    timeoutMs: timeoutMs(opts, operation),
    onAuthorizationUrl: (url) => {
      // The URL carries the client id and the state, never a secret; it is safe to show.
      ctx.err(noBrowser ? `open this URL to authorize ${provider.name}: ${url}` : `opening the browser to authorize ${provider.name}`);
    },
    ...(noBrowser ? { openBrowser: () => undefined } : { openBrowser: open }),
  };
}

function renderResult(data: ConnectResult, ctx: CommandContext): string[] {
  const lines = [`  ${ctx.theme.success("connected")} ${ctx.theme.value(data.provider)} ${ctx.theme.meta(`(${data.kind})`)}`];
  if (data.scopes.length > 0) lines.push(`  ${ctx.theme.meta("scopes")}   ${ctx.theme.body(data.scopes.join(", "))}`);
  if (data.expiresAt !== undefined) lines.push(`  ${ctx.theme.meta("expires")}  ${ctx.theme.value(data.expiresAt)}`);
  if (data.redirectUri !== undefined) lines.push(`  ${ctx.theme.meta("redirect")} ${ctx.theme.value(data.redirectUri)}`);
  lines.push(`  ${ctx.theme.meta("written")}  ${ctx.theme.body(data.written.join(", "))} ${ctx.theme.meta("(profile secrets file, 0600)")}`);
  return lines;
}

function renderListing(data: { providers: ConnectionRecord[] }, ctx: CommandContext): string[] {
  const lines = [ctx.theme.emphasis("CONNECTIONS")];
  for (const record of data.providers) {
    const mark = record.connected ? ctx.theme.success("connected  ") : record.appConfigured && record.kind === "oauth2" ? ctx.theme.needsApproval("app only   ") : ctx.theme.meta("not set    ");
    const detail = record.kind === "oauth2"
      ? record.connected
        ? `${record.scopes.join(", ")}${record.expiresAt === undefined ? "" : `  expires ${record.expiresAt}`}`
        : `trent connect ${record.provider}`
      : record.connected
        ? record.present.join(", ")
        : `trent connect ${record.provider}`;
    lines.push(`  ${mark} ${ctx.theme.value(record.provider.padEnd(8, " "))} ${ctx.theme.meta(record.kind.padEnd(8, " "))} ${ctx.theme.body(detail)}`);
  }
  return lines;
}

const listSpec: CommandSpec = {
  name: "list",
  description: "Show every provider with its kind, granted scopes and token expiry; never a value",
  run(ctx) {
    return listing(ctx);
  },
  render(data, ctx) {
    return renderListing(data as { providers: ConnectionRecord[] }, ctx);
  },
};

const removeSpec: CommandSpec = {
  name: "remove <provider>",
  description: "Drop a provider's tokens from the profile secrets file (an OAuth app registration stays)",
  run(ctx, _opts, args) {
    if (ctx.dryRun) return dryRun("connect remove", args[0]);
    const provider = providerArg(args[0], "connect.remove");
    const removed = new ConnectStore(ctx.config()).remove(provider.id);
    return { data: { provider: provider.id, removed } };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; provider: string; removed?: string[] };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would remove")} ${ctx.theme.value(d.provider)}`];
    if ((d.removed ?? []).length === 0) return [`  ${ctx.theme.meta("nothing stored for")} ${ctx.theme.value(d.provider)}`];
    return [`  ${ctx.theme.success("removed")} ${ctx.theme.value(d.provider)} ${ctx.theme.meta((d.removed ?? []).join(", "))}`];
  },
};

const refreshSpec: CommandSpec = {
  name: "refresh <provider>",
  description: "Renew an OAuth provider's access token now and report the new expiry",
  async run(ctx, opts, args) {
    if (ctx.dryRun) return dryRun("connect refresh", args[0]);
    const provider = providerArg(args[0], "connect.refresh");
    const deps = depsOverride ?? {};
    const result = await refreshOAuth(new ConnectStore(ctx.config()), provider.id, flowDeps(ctx, provider, opts, deps, "connect.refresh"));
    return { data: { ...result } };
  },
  render(data, ctx) {
    const d = data as unknown as ConnectResult & { dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would refresh")} ${ctx.theme.value(d.provider)}`];
    return [`  ${ctx.theme.success("refreshed")} ${ctx.theme.value(d.provider)}${d.expiresAt === undefined ? "" : ` ${ctx.theme.meta(`expires ${d.expiresAt}`)}`}`];
  },
};

export const connectSpec: CommandSpec = {
  name: "connect [provider]",
  description: "Connect a provider account (stripe, google, square, twilio, buffer, meta, bluesky); tokens go to the profile secrets file",
  options: [
    { flags: "--from-env [name]", description: "Read the secret from this environment variable, or every field from its own name" },
    { flags: "--username <value>", description: "The identifier of a basic pair (Twilio Account SID, Bluesky handle)" },
    { flags: "--port <port>", description: "Loopback port for the OAuth redirect; the default is a free one" },
    { flags: "--timeout <seconds>", description: "How long to wait for the browser", defaultValue: String(DEFAULT_TIMEOUT_SECONDS) },
    { flags: "--no-browser", description: "Print the authorization URL instead of opening a browser" },
  ],
  subcommands: [listSpec, removeSpec, refreshSpec],
  async run(ctx, opts, args) {
    if (args.length === 0) return listing(ctx);
    if (ctx.dryRun) return dryRun("connect", args[0]);
    const provider = providerArg(args[0], "connect");
    const deps = depsOverride ?? {};
    const store = new ConnectStore(ctx.config());
    if (provider.kind === "oauth2") {
      const result = await connectOAuth(store, provider.id, flowDeps(ctx, provider, opts, deps, `connect.${provider.id}`));
      return { data: { ...result } };
    }
    const values = await collectFields(provider, opts, deps);
    return { data: { ...connectFields(store, provider.id, values) } };
  },
  render(data, ctx) {
    const d = data as Record<string, unknown>;
    if (d.dryRun === true) {
      return [`  ${ctx.theme.meta("would connect")} ${ctx.theme.value(String(d.provider))} ${d.known === true ? ctx.theme.success(`(${String(d.kind)})`) : ctx.theme.needsApproval("(not a provider)")}`];
    }
    if (Array.isArray(d.providers)) return renderListing(d as unknown as { providers: ConnectionRecord[] }, ctx);
    return renderResult(d as unknown as ConnectResult, ctx);
  },
};
