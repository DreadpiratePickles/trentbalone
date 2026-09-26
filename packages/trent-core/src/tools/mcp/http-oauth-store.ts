/**
 * [H2] Where an http MCP server's OAuth state lives: the profile secrets file, under env NAMES derived
 * from the server name, and nowhere else. `config.yaml` carries only the reference
 * `Authorization: Bearer ${MCP_<NAME>_ACCESS_TOKEN}`, which is also how an entry is recognised as
 * OAuth-managed; no value is ever written there.
 *
 * Every write goes through `ConfigManager.saveSecrets` (atomic, mode 0600, the file the hardline list
 * already guards), and a login writes the client and the token set in ONE call so a second process
 * never reads a token without the client that must refresh it. The client is kept with the issuer
 * that registered it: the specification (2026-07-28, client-registration "Authorization Server
 * Binding") forbids reusing it with another authorization server.
 *
 * Two read surfaces, as in `connect/store.ts`: `status` returns names and metadata for the CLI and
 * the doctor and can never carry a value; `tokens` and `client` return values for the bearer source.
 */
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";

export interface McpOAuthEnvNames {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: string;
  readonly scopes: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientAuth: string;
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly resource: string;
  readonly redirectUri: string;
}

/** `linear-app` -> `MCP_LINEAR_APP`. Two names that differ only by `-` and `_` share it; `trent mcp add` refuses that. */
export function mcpOAuthEnvPrefix(server: string): string {
  return `MCP_${server.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function mcpOAuthEnvNames(server: string): McpOAuthEnvNames {
  const p = mcpOAuthEnvPrefix(server);
  return {
    access: `${p}_ACCESS_TOKEN`,
    refresh: `${p}_REFRESH_TOKEN`,
    expiresAt: `${p}_TOKEN_EXPIRES_AT`,
    scopes: `${p}_TOKEN_SCOPES`,
    clientId: `${p}_OAUTH_CLIENT_ID`,
    clientSecret: `${p}_OAUTH_CLIENT_SECRET`,
    clientAuth: `${p}_OAUTH_CLIENT_AUTH`,
    issuer: `${p}_OAUTH_ISSUER`,
    tokenUrl: `${p}_OAUTH_TOKEN_URL`,
    resource: `${p}_OAUTH_RESOURCE`,
    redirectUri: `${p}_OAUTH_REDIRECT_URI`,
  };
}

/** The one header value an OAuth-managed entry carries: a reference, never a value. */
export function mcpOAuthHeaderTemplate(server: string): string {
  return `Bearer \${${mcpOAuthEnvNames(server).access}}`;
}

/** True when the entry's `Authorization` header is exactly this server's OAuth reference. */
export function isMcpOAuthEntry(server: string, headers: Readonly<Record<string, string>>): boolean {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization");
  return entry !== undefined && entry[1].trim() === mcpOAuthHeaderTemplate(server);
}

/** The command that runs (or re-runs) the browser login for a configured server. */
export function mcpLoginCommand(server: string): string {
  return `trent mcp test ${server} --oauth`;
}

export type McpClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

/** The client a login registered, bound to the issuer that registered it. Values: bearer source only. */
export interface McpOAuthClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authMethod: McpClientAuthMethod;
  readonly issuer: string;
  readonly tokenUrl: string;
  readonly resource: string;
  readonly redirectUri: string;
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
}

export type McpAuthState = "connected" | "expired" | "needs-login";

/** What `trent mcp list` and the doctor show. Names and metadata; no field is a value. */
export interface McpAuthStatus {
  readonly server: string;
  readonly state: McpAuthState;
  /** A refresh token is stored, so an expired access token renews itself on the next connect. */
  readonly refreshable: boolean;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
  readonly issuer?: string;
  /** Env names present in the secrets file. */
  readonly present: readonly string[];
  readonly login: string;
}

const AUTH_METHODS: readonly McpClientAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];

function filled(value: string | undefined): value is string {
  return typeof value === "string" && value !== "";
}

export function isExpired(expiresAt: string | undefined, now: Date): boolean {
  if (expiresAt === undefined) return false;
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && at <= now.getTime();
}

export class McpOAuthStore {
  constructor(private readonly manager: ConfigManager) {}

  /**
   * The store for a profile directory, as the seat's tool builder knows it. `ConfigManager` puts the
   * default profile at the base directory and every other one at `<base>/profiles/<name>`; either
   * reading yields the same `<profileDir>/.env`.
   */
  static forProfileDir(profileDir: string): McpOAuthStore {
    const parent = path.dirname(profileDir);
    const named = path.basename(parent) === "profiles";
    return new McpOAuthStore(new ConfigManager(named ? { baseDir: path.dirname(parent), profile: path.basename(profileDir) } : { baseDir: profileDir, profile: "default" }));
  }

  public path(): string {
    return this.manager.getSecretsPath();
  }

  public profileDir(): string {
    return this.manager.getProfileDir();
  }

  public tokens(server: string): McpOAuthTokens | undefined {
    const n = mcpOAuthEnvNames(server);
    const s = this.secrets();
    const accessToken = s[n.access];
    if (!filled(accessToken)) return undefined;
    const refreshToken = s[n.refresh];
    const expiresAt = s[n.expiresAt];
    return { accessToken, ...(filled(refreshToken) ? { refreshToken } : {}), ...(filled(expiresAt) ? { expiresAt } : {}), scopes: splitScopes(s[n.scopes]) };
  }

  public client(server: string): McpOAuthClient | undefined {
    const n = mcpOAuthEnvNames(server);
    const s = this.secrets();
    const [clientId, issuer, tokenUrl, resource, redirectUri] = [s[n.clientId], s[n.issuer], s[n.tokenUrl], s[n.resource], s[n.redirectUri]];
    if (!filled(clientId) || !filled(issuer) || !filled(tokenUrl) || !filled(resource) || !filled(redirectUri)) return undefined;
    const method = AUTH_METHODS.find((m) => m === s[n.clientAuth]) ?? "none";
    const clientSecret = s[n.clientSecret];
    return { clientId, ...(filled(clientSecret) ? { clientSecret } : {}), authMethod: method, issuer, tokenUrl, resource, redirectUri };
  }

  /** A completed login: the client and the token set in one atomic write. Returns the names written. */
  public writeLogin(server: string, client: McpOAuthClient, tokens: McpOAuthTokens): string[] {
    const n = mcpOAuthEnvNames(server);
    const values: Record<string, string> = {
      [n.clientId]: client.clientId,
      [n.clientSecret]: client.clientSecret ?? "",
      [n.clientAuth]: client.authMethod,
      [n.issuer]: client.issuer,
      [n.tokenUrl]: client.tokenUrl,
      [n.resource]: client.resource,
      [n.redirectUri]: client.redirectUri,
      ...this.tokenValues(server, tokens),
    };
    this.manager.saveSecrets(values);
    return Object.entries(values).filter(([, v]) => v !== "").map(([k]) => k);
  }

  /** A refresh: the new token set; the stored refresh token is kept when none arrives. */
  public writeTokens(server: string, tokens: McpOAuthTokens): void {
    this.manager.saveSecrets(this.tokenValues(server, tokens));
  }

  public status(server: string, now: Date): McpAuthStatus {
    const n = mcpOAuthEnvNames(server);
    const s = this.secrets();
    const present = Object.values(n).filter((env) => filled(s[env]));
    const tokens = this.tokens(server);
    const issuer = s[n.issuer];
    const base = { server, login: mcpLoginCommand(server), present, ...(filled(issuer) ? { issuer } : {}) };
    if (tokens === undefined) return { ...base, state: "needs-login", refreshable: false, scopes: [] };
    return {
      ...base,
      state: isExpired(tokens.expiresAt, now) ? "expired" : "connected",
      refreshable: tokens.refreshToken !== undefined && this.client(server) !== undefined,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
      scopes: tokens.scopes,
    };
  }

  /** Forget the server's OAuth state (client and tokens). Returns the names removed. */
  public remove(server: string): string[] {
    const s = this.secrets();
    const removed = Object.values(mcpOAuthEnvNames(server)).filter((env) => filled(s[env]));
    if (removed.length === 0) return [];
    this.manager.saveSecrets(Object.fromEntries(removed.map((env) => [env, ""])));
    for (const env of removed) delete process.env[env];
    return removed;
  }

  private tokenValues(server: string, tokens: McpOAuthTokens): Record<string, string> {
    const n = mcpOAuthEnvNames(server);
    const accessToken = tokens.accessToken.trim();
    if (accessToken === "") throw new Error(`${n.access} is empty`);
    const previous = this.secrets()[n.refresh];
    return {
      [n.access]: accessToken,
      [n.refresh]: tokens.refreshToken?.trim() || (filled(previous) ? previous : ""),
      [n.expiresAt]: tokens.expiresAt ?? "",
      [n.scopes]: tokens.scopes.join(" "),
    };
  }

  /** Always the file, never the cache: a refresh in another process must be visible here. */
  private secrets(): Record<string, string | undefined> {
    return this.manager.loadSecrets({ force: true }) as Record<string, string | undefined>;
  }
}

function splitScopes(value: string | undefined): string[] {
  return filled(value) ? value.split(/\s+/).filter((s) => s !== "") : [];
}
