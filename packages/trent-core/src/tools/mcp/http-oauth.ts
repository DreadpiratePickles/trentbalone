/**
 * [H2] OAuth 2.1 for http MCP servers: the browser login and the bearer a connection sends.
 *
 * The login is the specification's flow (MCP authorization 2026-07-28, "Authorization Flow Steps"):
 * an unauthenticated request for the 401 challenge, protected-resource then authorization-server
 * discovery (`./http-oauth-wire.ts`), a client (the one this profile registered with that issuer, else
 * RFC 7591 registration), then the authorization code grant with S256 PKCE and `resource` on the
 * `trent connect` loopback listener (`connect/loopback.ts`, which also checks `state` and, per RFC 9207,
 * `iss`), and the exchange through `connect/oauth.ts` `requestTokenAt`. It runs only when a person asks
 * (`trent mcp add --oauth`, `trent mcp test --oauth`): a seat or a cron job never opens a browser.
 *
 * The bearer source is what a connection uses: the stored access token, renewed before it expires
 * (inside `REFRESH_WINDOW_MS`, the `trent connect` window) and once more when the server answers 401,
 * each refresh under `withRefreshLock` so racing connections produce one refresh. When nothing can be
 * renewed it throws the login hint. Nothing here prints, logs or returns a token.
 */
import { EXIT, TrentError } from "../../errors/index.js";
import { withRefreshLock } from "../../connect/lock.js";
import { startLoopback, type LoopbackListener } from "../../connect/loopback.js";
import { pkcePair, randomUrlToken, requestTokenAt, type TokenResponse } from "../../connect/oauth.js";
import { REFRESH_WINDOW_MS } from "../../connect/resolver.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";
import { isExpired, mcpLoginCommand, McpOAuthStore, type McpOAuthClient, type McpOAuthTokens } from "./http-oauth-store.js";
import { discoverAuthorizationServer, discoverProtectedResource, probeChallenge, registerClient, type OAuthFetch, type WireDeps } from "./http-oauth-wire.js";

export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface McpLoginDeps {
  readonly store: McpOAuthStore;
  /** Defaults to the process fetch: the login is a user action, like `trent connect`. */
  readonly fetchImpl?: OAuthFetch;
  readonly lookup?: LookupFn;
  readonly openBrowser?: (url: string) => void | Promise<void>;
  /** Called with the authorization URL before the browser opens, so a CLI can show it. */
  readonly onAuthorizationUrl?: (url: string) => void;
  /** Loopback port; 0 (the default) picks a free one, or reuses the registered client's. */
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** What a login reports: names, the issuer, the resource. No field is a value. */
export interface McpLoginResult {
  readonly server: string;
  readonly issuer: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  readonly hasRefreshToken: boolean;
  readonly registration: "dynamic" | "stored";
  readonly redirectUri: string;
  /** Env names written to the profile secrets file. */
  readonly written: readonly string[];
}

/** The error a connection fails with when only a person can fix it. Its message names the command. */
export function mcpLoginRequired(server: string, why: string): TrentError {
  return new TrentError({ code: EXIT.AUTH, operation: "mcp.oauth", message: `${server} ${why}; log in with ${mcpLoginCommand(server)}`, target: server });
}

function clientAuth(client: Pick<McpOAuthClient, "clientId" | "clientSecret" | "authMethod">): { params: Record<string, string>; headers: Record<string, string> } {
  if (client.authMethod === "client_secret_basic" && client.clientSecret !== undefined) {
    const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64");
    return { params: {}, headers: { authorization: `Basic ${basic}` } };
  }
  if (client.authMethod === "client_secret_post" && client.clientSecret !== undefined) return { params: { client_id: client.clientId, client_secret: client.clientSecret }, headers: {} };
  return { params: { client_id: client.clientId }, headers: {} };
}

function tokensOf(token: TokenResponse, fallbackScopes: readonly string[]): McpOAuthTokens {
  return {
    accessToken: token.accessToken,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
    scopes: token.scopes ?? fallbackScopes,
  };
}

/** A listener on the registered client's port when there is one, else on `port`. */
async function listen(server: string, stored: McpOAuthClient | undefined, port: number, state: string, expectedIssuer: { issuer: string; required: boolean }): Promise<LoopbackListener> {
  const options = { providerName: `MCP server ${server}`, redirectHost: "127.0.0.1" as const, expectedState: state, expectedIssuer };
  const reuse = stored === undefined ? undefined : Number(new URL(stored.redirectUri).port);
  if (reuse !== undefined && Number.isInteger(reuse) && reuse > 0 && port === 0) {
    try {
      return await startLoopback({ ...options, port: reuse });
    } catch {
      // The port is taken; a new one means a new registration below.
    }
  }
  return startLoopback({ ...options, port });
}

function selectScope(challengeScope: string | undefined, resourceScopes: readonly string[] | undefined, serverScopes: readonly string[] | undefined): string | undefined {
  const base = challengeScope?.trim() || resourceScopes?.join(" ") || undefined;
  if (base === undefined) return undefined;
  // offline_access asks for a refresh token; only where the authorization server lists it (spec, "Refresh Tokens").
  return serverScopes?.includes("offline_access") && !base.split(/\s+/).includes("offline_access") ? `${base} offline_access` : base;
}

/** The browser login. Writes the client and the tokens to the profile secrets file in one step. */
export async function loginMcpServer(server: string, url: string, deps: McpLoginDeps): Promise<McpLoginResult> {
  const now = deps.now ?? (() => new Date());
  const wire: WireDeps = { fetchImpl: deps.fetchImpl ?? ((u, init) => fetch(u, init)), ...(deps.lookup === undefined ? {} : { lookup: deps.lookup }), allowHttp: new URL(url).protocol === "http:" };

  const challenge = await probeChallenge(url, wire);
  const resource = await discoverProtectedResource(url, challenge, wire);
  const metadata = await discoverAuthorizationServer(resource.authorizationServers[0]!, wire);
  const scope = selectScope(challenge?.scope, resource.scopesSupported, metadata.scopesSupported);

  const previous = deps.store.client(server);
  // Authorization server binding: a client registered with another issuer is never reused.
  const stored = previous !== undefined && previous.issuer === metadata.issuer && previous.tokenUrl === metadata.tokenEndpoint ? previous : undefined;
  const state = randomUrlToken();
  const pkce = pkcePair();
  const listener = await listen(server, stored, deps.port ?? 0, state, { issuer: metadata.issuer, required: metadata.issParameterSupported });
  try {
    const reused = stored !== undefined && stored.redirectUri === listener.redirectUri;
    const registered = reused ? stored : await registerClient(metadata, listener.redirectUri, scope, wire);
    const authorization = new URL(metadata.authorizationEndpoint);
    const query: Record<string, string> = {
      response_type: "code",
      client_id: registered.clientId,
      redirect_uri: listener.redirectUri,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: resource.resource,
      ...(scope === undefined ? {} : { scope }),
    };
    for (const [key, value] of Object.entries(query)) authorization.searchParams.set(key, value);
    deps.onAuthorizationUrl?.(authorization.toString());
    // Not awaited: an opener that blocks until the tab closes would deadlock the wait.
    void Promise.resolve()
      .then(() => deps.openBrowser?.(authorization.toString()))
      .catch(() => undefined);
    const code = await listener.waitForCode(deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);

    await floorOrRefuse(metadata.tokenEndpoint, wire.lookup);
    const auth = clientAuth(registered);
    const token = await requestTokenAt({
      endpoint: metadata.tokenEndpoint,
      params: { grant_type: "authorization_code", code, redirect_uri: listener.redirectUri, code_verifier: pkce.verifier, resource: resource.resource, ...auth.params },
      headers: auth.headers,
      fetchImpl: wire.fetchImpl,
      now,
      label: `the authorization server ${metadata.issuer}`,
      operation: "mcp.oauth.token",
    });
    const client: McpOAuthClient = {
      clientId: registered.clientId,
      ...(registered.clientSecret === undefined ? {} : { clientSecret: registered.clientSecret }),
      authMethod: registered.authMethod,
      issuer: metadata.issuer,
      tokenUrl: metadata.tokenEndpoint,
      resource: resource.resource,
      redirectUri: listener.redirectUri,
    };
    const tokens = tokensOf(token, scope?.split(/\s+/) ?? []);
    const written = deps.store.writeLogin(server, client, tokens);
    return {
      server,
      issuer: metadata.issuer,
      resource: resource.resource,
      scopes: tokens.scopes,
      ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
      hasRefreshToken: deps.store.tokens(server)?.refreshToken !== undefined,
      registration: reused ? "stored" : "dynamic",
      redirectUri: listener.redirectUri,
      written,
    };
  } finally {
    await listener.close();
  }
}

async function floorOrRefuse(url: string, lookup: LookupFn | undefined): Promise<void> {
  const verdict = await checkUrlSafety(url, { lookup });
  if (!verdict.ok) throw new TrentError({ code: EXIT.AUTH, operation: "mcp.oauth", message: `${new URL(url).host} was refused by the SSRF floor: ${verdict.reason}`, target: new URL(url).host });
}

export interface McpBearerSourceDeps {
  readonly store: McpOAuthStore;
  /** How the token endpoint is reached: the egress fetch with the own-credential marker in a seat. */
  readonly fetchImpl: OAuthFetch;
  readonly lookup?: LookupFn;
  readonly now?: () => Date;
}

export interface McpBearerSource {
  /** The access token to send now, renewed first when it is inside the refresh window. */
  current(): Promise<string>;
  /** The server refused `rejected`: a peer's newer token, a refreshed one, or undefined when none can be had. */
  afterRejection(rejected: string): Promise<string | undefined>;
}

function withinWindow(tokens: McpOAuthTokens, now: Date): boolean {
  if (tokens.expiresAt === undefined) return false;
  const at = Date.parse(tokens.expiresAt);
  return Number.isFinite(at) && at - now.getTime() <= REFRESH_WINDOW_MS;
}

async function refresh(server: string, client: McpOAuthClient, refreshToken: string, deps: McpBearerSourceDeps, now: () => Date): Promise<McpOAuthTokens> {
  await floorOrRefuse(client.tokenUrl, deps.lookup);
  const auth = clientAuth(client);
  let token: TokenResponse;
  try {
    token = await requestTokenAt({
      endpoint: client.tokenUrl,
      params: { grant_type: "refresh_token", refresh_token: refreshToken, resource: client.resource, ...auth.params },
      headers: auth.headers,
      fetchImpl: deps.fetchImpl,
      now,
      label: `the authorization server ${client.issuer}`,
      operation: "mcp.oauth.refresh",
    });
  } catch (err) {
    throw mcpLoginRequired(server, `could not renew its token (${err instanceof Error ? err.message : String(err)})`);
  }
  const stored = deps.store.tokens(server);
  const tokens = tokensOf(token, stored?.scopes ?? []);
  deps.store.writeTokens(server, tokens);
  return deps.store.tokens(server) ?? tokens;
}

export function createBearerSource(server: string, deps: McpBearerSourceDeps): McpBearerSource {
  const now = deps.now ?? (() => new Date());
  const lockKey = `mcp-${server}`;

  async function renew(force: boolean, rejected?: string): Promise<string | undefined> {
    return withRefreshLock(deps.store.profileDir(), lockKey, async () => {
      // Re-read under the lock: a peer may have renewed while this caller waited.
      const tokens = deps.store.tokens(server);
      if (tokens === undefined) throw mcpLoginRequired(server, "has no stored OAuth token");
      if (rejected !== undefined && tokens.accessToken !== rejected && !isExpired(tokens.expiresAt, now())) return tokens.accessToken;
      if (!force && !withinWindow(tokens, now())) return tokens.accessToken;
      const client = deps.store.client(server);
      if (tokens.refreshToken === undefined || client === undefined) {
        if (force) return undefined;
        if (isExpired(tokens.expiresAt, now())) throw mcpLoginRequired(server, `has an OAuth token that expired at ${tokens.expiresAt} and no refresh token`);
        return tokens.accessToken;
      }
      return (await refresh(server, client, tokens.refreshToken, deps, now)).accessToken;
    });
  }

  return {
    async current() {
      const tokens = deps.store.tokens(server);
      if (tokens === undefined) throw mcpLoginRequired(server, "has no stored OAuth token (never logged in, or removed)");
      if (!withinWindow(tokens, now())) return tokens.accessToken;
      const renewed = await renew(false);
      if (renewed === undefined) throw mcpLoginRequired(server, "has no usable OAuth token");
      return renewed;
    },
    afterRejection(rejected) {
      return renew(true, rejected);
    },
  };
}
