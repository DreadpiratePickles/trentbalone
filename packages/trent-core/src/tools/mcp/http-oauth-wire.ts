/**
 * [H2] The discovery and registration wire of MCP authorization, specification revision 2026-07-28
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization and its
 * `authorization-server-discovery`, `client-registration` and `security-considerations` pages).
 *
 *   RFC 6750 s.3   the `WWW-Authenticate: Bearer` challenge (`resource_metadata`, `scope`, `error`)
 *   RFC 9728       protected-resource metadata: the challenge's URL, else the path-aware then the root
 *                  well-known URI; its `resource` must be this server (s.3.3) or the data is not used
 *   RFC 8414/OIDC  authorization-server metadata in the specification's order; the document's `issuer`
 *                  must be identical to the one the URL was built from, or it is not used
 *   RFC 7636       `code_challenge_methods_supported` absent, or without S256: refuse to proceed
 *   RFC 7591       dynamic registration of a native public client for the loopback redirect URI
 *   RFC 8707       the canonical resource URI sent as `resource`
 *
 * Every URL fetched here came from a server's answer, so each one passes the SSRF floor
 * (`checkUrlSafety`) before any request, redirects are never followed, bodies are bounded, and an
 * authorization-server endpoint must be https unless the MCP server itself was configured over plain
 * http (a development setup the user chose; the bearer already travels in the clear there). Errors
 * name hosts, statuses and fields, never a body.
 */
import { EXIT, TrentError, type ExitCode } from "../../errors/index.js";
import { RedirectBlockedError } from "../web/proxied-fetch.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";

export type OAuthFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WireDeps {
  readonly fetchImpl: OAuthFetch;
  readonly lookup?: LookupFn;
  /** True only when the MCP server's own URL is plain http. */
  readonly allowHttp: boolean;
}

export interface BearerChallenge {
  readonly resourceMetadata?: string;
  readonly scope?: string;
  readonly error?: string;
}

export interface ProtectedResourceMetadata {
  /** The resource identifier to send as `resource`: the metadata's own, validated against the server URL. */
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported?: readonly string[];
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
  /** RFC 9207 s.2.3: the server promised `iss` on every authorization response. */
  readonly issParameterSupported: boolean;
}

export interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authMethod: "none" | "client_secret_post" | "client_secret_basic";
}

const MAX_BODY_CHARS = 64 * 1024;
const OPERATION = "mcp.oauth";

function refuse(message: string, target?: string, code: ExitCode = EXIT.AUTH): TrentError {
  return new TrentError({ code, operation: OPERATION, message, ...(target === undefined ? {} : { target }) });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unparseable URL";
  }
}

/** RFC 6750 s.3 auth-params of the Bearer challenge; undefined when the header is not a Bearer challenge. */
export function parseBearerChallenge(header: string | null | undefined): BearerChallenge | undefined {
  if (header === null || header === undefined || !/^\s*Bearer\b/i.test(header)) return undefined;
  const params: Record<string, string> = {};
  for (const match of header.replace(/^\s*Bearer\s*/i, "").matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[match[1]!.toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return {
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

/** RFC 8707 s.2: lowercase scheme and host, no query, no fragment, no trailing slash. */
export function canonicalResourceUri(serverUrl: string): string {
  const url = new URL(serverUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
}

/** RFC 9728 s.3.1: the path-aware URI first when the server has a path, then the root. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const url = new URL(serverUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return pathname === "" ? [root] : [`${root}${pathname}`, root];
}

/** The specification's order: RFC 8414 path insertion, OIDC path insertion, OIDC path appending. */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  return [
    `${url.origin}/.well-known/oauth-authorization-server${pathname}`,
    `${url.origin}/.well-known/openid-configuration${pathname}`,
    `${url.origin}${pathname}/.well-known/openid-configuration`,
  ];
}

/** An authorization-server URL must be https (spec, security considerations 3.1) unless the MCP server is plain http. */
export function requireSecureEndpoint(url: string, what: string, deps: Pick<WireDeps, "allowHttp">): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse(`${what} is not a valid absolute URL`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && deps.allowHttp) return;
  throw refuse(`${what} at ${parsed.host} is not https; every authorization server endpoint must be (MCP authorization, security considerations)`, parsed.host);
}

async function floor(url: string, deps: WireDeps): Promise<void> {
  const verdict = await checkUrlSafety(url, { lookup: deps.lookup });
  if (!verdict.ok) throw refuse(`${hostOf(url)} was refused by the SSRF floor: ${verdict.reason}`, hostOf(url));
}

/** One request with the floor, no redirects, and a bounded body. `undefined` for a 4xx the caller may skip. */
async function fetchJson(url: string, init: RequestInit, deps: WireDeps, what: string): Promise<{ status: number; body: Record<string, unknown> } | { status: number; body?: undefined }> {
  await floor(url, deps);
  let response: Response;
  try {
    response = await deps.fetchImpl(url, { ...init, redirect: "manual" });
  } catch (err) {
    if (err instanceof RedirectBlockedError) throw refuse(`${what} at ${hostOf(url)} answered a redirect; OAuth metadata and endpoints are never followed across one`, hostOf(url));
    throw new TrentError({ code: EXIT.PROVIDER, operation: OPERATION, message: `${what} at ${hostOf(url)} could not be reached`, target: hostOf(url), cause: err });
  }
  if (response.status >= 300 && response.status < 400) throw refuse(`${what} at ${hostOf(url)} answered a redirect; OAuth metadata and endpoints are never followed across one`, hostOf(url));
  const text = await response.text().catch(() => "");
  if (!response.ok) return { status: response.status };
  if (text.length > MAX_BODY_CHARS) throw refuse(`${what} at ${hostOf(url)} answered more than ${MAX_BODY_CHARS} characters`, hostOf(url), EXIT.PROVIDER);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse(`${what} at ${hostOf(url)} did not answer JSON`, hostOf(url), EXIT.PROVIDER);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw refuse(`${what} at ${hostOf(url)} did not answer a JSON object`, hostOf(url), EXIT.PROVIDER);
  return { status: response.status, body: parsed as Record<string, unknown> };
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

function sameResource(advertised: string, server: string): boolean {
  if (advertised === server) return true;
  // The metadata may name a less specific resource on the same origin (the root document names the origin).
  return new URL(advertised).origin === new URL(server).origin && server.startsWith(`${advertised}/`);
}

/** RFC 9728: the challenge's `resource_metadata` when present, else the well-known URIs in order. */
export async function discoverProtectedResource(serverUrl: string, challenge: BearerChallenge | undefined, deps: WireDeps): Promise<ProtectedResourceMetadata> {
  const server = canonicalResourceUri(serverUrl);
  const candidates = challenge?.resourceMetadata !== undefined ? [challenge.resourceMetadata] : protectedResourceMetadataUrls(serverUrl);
  for (const url of candidates) {
    requireSecureEndpoint(url, "the protected-resource metadata", deps);
    const answer = await fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, deps, "the protected-resource metadata");
    if (answer.body === undefined) {
      if (answer.status >= 400 && answer.status < 500 && challenge?.resourceMetadata === undefined) continue;
      throw refuse(`the protected-resource metadata at ${hostOf(url)} answered ${answer.status}`, hostOf(url), EXIT.PROVIDER);
    }
    const resource = typeof answer.body.resource === "string" ? canonicalResourceUri(answer.body.resource) : undefined;
    if (resource === undefined || !sameResource(resource, server)) {
      throw refuse(`the protected-resource metadata at ${hostOf(url)} names ${resource ?? "no resource"}, not ${server}; its data is not used (RFC 9728 section 3.3)`, hostOf(url));
    }
    const authorizationServers = strings(answer.body.authorization_servers) ?? [];
    if (authorizationServers.length === 0) throw refuse(`the protected-resource metadata at ${hostOf(url)} names no authorization server`, hostOf(url));
    const scopesSupported = strings(answer.body.scopes_supported);
    return { resource, authorizationServers, ...(scopesSupported === undefined ? {} : { scopesSupported }) };
  }
  throw refuse(`${hostOf(serverUrl)} publishes no protected-resource metadata (RFC 9728), so it does not support MCP authorization`, hostOf(serverUrl));
}

/** RFC 8414 / OIDC discovery with the issuer identity check and the PKCE refusal. */
export async function discoverAuthorizationServer(issuer: string, deps: WireDeps): Promise<AuthorizationServerMetadata> {
  requireSecureEndpoint(issuer, "the authorization server", deps);
  for (const url of authorizationServerMetadataUrls(issuer)) {
    const answer = await fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, deps, "the authorization server metadata");
    if (answer.body === undefined) {
      if (answer.status >= 400 && answer.status < 500) continue;
      throw refuse(`the authorization server metadata at ${hostOf(url)} answered ${answer.status}`, hostOf(url), EXIT.PROVIDER);
    }
    const body = answer.body;
    if (body.issuer !== issuer) throw refuse(`the metadata at ${hostOf(url)} names issuer ${String(body.issuer)}, not ${issuer}; it is not used (RFC 8414 section 3.3)`, hostOf(url));
    const methods = strings(body.code_challenge_methods_supported);
    if (methods === undefined) throw refuse(`the authorization server ${issuer} publishes no code_challenge_methods_supported, so it does not support PKCE; refused`, hostOf(url));
    if (!methods.includes("S256")) throw refuse(`the authorization server ${issuer} does not offer S256 PKCE (it offers ${methods.join(", ") || "nothing"}); refused`, hostOf(url));
    const responseTypes = strings(body.response_types_supported);
    if (responseTypes !== undefined && !responseTypes.includes("code")) throw refuse(`the authorization server ${issuer} does not offer the authorization code flow`, hostOf(url));
    const endpoint = (field: string): string | undefined => (typeof body[field] === "string" ? (body[field] as string) : undefined);
    const authorizationEndpoint = endpoint("authorization_endpoint");
    const tokenEndpoint = endpoint("token_endpoint");
    if (authorizationEndpoint === undefined || tokenEndpoint === undefined) throw refuse(`the metadata of ${issuer} lacks an authorization or token endpoint`, hostOf(url), EXIT.PROVIDER);
    requireSecureEndpoint(authorizationEndpoint, "the authorization endpoint", deps);
    requireSecureEndpoint(tokenEndpoint, "the token endpoint", deps);
    const registrationEndpoint = endpoint("registration_endpoint");
    if (registrationEndpoint !== undefined) requireSecureEndpoint(registrationEndpoint, "the registration endpoint", deps);
    const scopesSupported = strings(body.scopes_supported);
    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
      ...(scopesSupported === undefined ? {} : { scopesSupported }),
      issParameterSupported: body.authorization_response_iss_parameter_supported === true,
    };
  }
  throw refuse(`no authorization server metadata was found for ${issuer} (RFC 8414 or OpenID Connect discovery)`, hostOf(issuer));
}

/** RFC 7591: a native public client for exactly this loopback redirect URI. */
export async function registerClient(metadata: AuthorizationServerMetadata, redirectUri: string, scope: string | undefined, deps: WireDeps): Promise<RegisteredClient> {
  const endpoint = metadata.registrationEndpoint;
  if (endpoint === undefined) {
    throw refuse(`the authorization server ${metadata.issuer} offers no dynamic client registration (RFC 7591) and Trent has no client registered with it`, hostOf(metadata.issuer));
  }
  const request = {
    client_name: "Trent Fleet",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    ...(scope === undefined ? {} : { scope }),
  };
  const answer = await fetchJson(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(request) }, deps, "the registration endpoint");
  if (answer.body === undefined) throw refuse(`the registration endpoint of ${metadata.issuer} answered ${answer.status}`, hostOf(endpoint), EXIT.PROVIDER);
  const clientId = answer.body.client_id;
  if (typeof clientId !== "string" || clientId === "") throw refuse(`the registration endpoint of ${metadata.issuer} answered without a client_id`, hostOf(endpoint), EXIT.PROVIDER);
  const secret = typeof answer.body.client_secret === "string" && answer.body.client_secret !== "" ? answer.body.client_secret : undefined;
  const echoed = answer.body.token_endpoint_auth_method;
  const authMethod = secret === undefined ? "none" : echoed === "client_secret_post" ? "client_secret_post" : "client_secret_basic";
  return { clientId, ...(secret === undefined ? {} : { clientSecret: secret }), authMethod };
}

/** The unauthenticated first request of the specification's flow: an `initialize` POST, read for its challenge. */
export async function probeChallenge(serverUrl: string, deps: WireDeps): Promise<BearerChallenge | undefined> {
  await floor(serverUrl, deps);
  let response: Response;
  try {
    response = await deps.fetchImpl(serverUrl, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "trent-fleet", version: "1.0.0" } } }),
    });
  } catch (err) {
    throw new TrentError({ code: EXIT.PROVIDER, operation: OPERATION, message: `${hostOf(serverUrl)} could not be reached`, target: hostOf(serverUrl), cause: err });
  }
  await response.body?.cancel().catch(() => undefined);
  return response.status === 401 ? parseBearerChallenge(response.headers.get("www-authenticate")) : undefined;
}
