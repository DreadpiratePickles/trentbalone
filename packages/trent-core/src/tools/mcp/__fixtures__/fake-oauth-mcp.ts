/**
 * [H2] A fake OAuth 2.1 authorization server and a fake OAuth-protected Streamable HTTP MCP server,
 * for the MCP authorization tests. Both listen on 127.0.0.1 but describe themselves by public-looking
 * names (`auth.fake.test`, `mcp.fake.test`), so the client's SSRF floor passes through `LOOKUP` (a
 * TEST-NET answer) and a test reaches them either through `routingFetch` or through the real egress
 * proxy's `upstreamOverrides`.
 *
 * The authorization server checks what a real one must: an exact redirect URI per registered client,
 * S256 PKCE (the verifier must hash to the challenge), the `resource` of the authorization request
 * repeated at the token endpoint (RFC 8707), refresh-token rotation for public clients, and it binds
 * every access token to its resource. The MCP server accepts a bearer only when the authorization
 * server issued it FOR THIS resource, so a token that reached it proves the audience travelled.
 * Every request either server receives is recorded, headers included, for the egress assertions.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "../../web/url-safety.js";

export const LOOKUP: LookupFn = async () => [{ address: "203.0.113.7", family: 4 }];
export const AS_HOST = "auth.fake.test";
export const MCP_HOST = "mcp.fake.test";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

/** One recording HTTP listener on 127.0.0.1; `handle` answers each request after its body is read. */
class Listener {
  readonly requests: Recorded[] = [];
  port = 0;
  private server?: http.Server;

  constructor(private readonly handle: (req: Recorded, res: http.ServerResponse) => void) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const recorded = { method: (req.method ?? "GET").toUpperCase(), path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        this.requests.push(recorded);
        this.handle(recorded, res);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export interface FakeAuthServerOptions {
  /** Path of the issuer identifier (`/tenant1`); empty for a root issuer. */
  readonly issuerPath?: string;
  /** `code_challenge_methods_supported`; `null` omits the field. Default `["S256"]`. */
  readonly pkceMethods?: readonly string[] | null;
  /** Serve a `registration_endpoint` (RFC 7591). Default true. */
  readonly registration?: boolean;
  /** Where the metadata document is served. Default the RFC 8414 path-inserted URL. */
  readonly metadataAt?: "oauth" | "oidc-appended";
  /** Publish an `issuer` other than the one the URL was built from. */
  readonly wrongIssuer?: boolean;
  /** The `iss` the authorization redirect carries (RFC 9207). Default the real issuer. */
  readonly issInResponse?: "correct" | "wrong" | "absent";
  readonly expiresIn?: number;
}

interface Code {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly resource: string;
  used: boolean;
}

export class FakeAuthServer {
  readonly publicBase = `http://${AS_HOST}`;
  readonly issued = { codes: [] as string[], accessTokens: [] as string[], refreshTokens: [] as string[], clientIds: [] as string[] };
  private readonly listener = new Listener((req, res) => this.route(req, res));
  private readonly clients = new Map<string, readonly string[]>();
  private readonly codes = new Map<string, Code>();
  private readonly access = new Map<string, string>();
  private readonly refresh = new Map<string, { clientId: string; resource: string }>();

  constructor(private readonly options: FakeAuthServerOptions = {}) {}

  get issuer(): string {
    return `${this.publicBase}${this.options.issuerPath ?? ""}`;
  }
  get port(): number {
    return this.listener.port;
  }
  get requests(): Recorded[] {
    return this.listener.requests;
  }
  get registrations(): Record<string, unknown>[] {
    return this.requests.filter((r) => r.path === "/register").map((r) => JSON.parse(r.body) as Record<string, unknown>);
  }
  get authorizeRequests(): URLSearchParams[] {
    return this.requests.filter((r) => r.path.startsWith("/authorize")).map((r) => new URL(r.path, this.publicBase).searchParams);
  }
  get tokenRequests(): Record<string, string>[] {
    return this.requests.filter((r) => r.path === "/token").map((r) => Object.fromEntries(new URLSearchParams(r.body).entries()));
  }

  start(): Promise<void> {
    return this.listener.start();
  }
  stop(): Promise<void> {
    return this.listener.stop();
  }

  /** True when this server issued `accessToken` for `resource` and has not revoked it. */
  accepts(accessToken: string, resource: string): boolean {
    return this.access.get(accessToken) === resource;
  }
  revoke(accessToken: string): void {
    this.access.delete(accessToken);
  }

  private metadataPath(): string {
    const path = this.options.issuerPath ?? "";
    return this.options.metadataAt === "oidc-appended" ? `${path}/.well-known/openid-configuration` : `/.well-known/oauth-authorization-server${path}`;
  }

  private route(req: Recorded, res: http.ServerResponse): void {
    const url = new URL(req.path, this.publicBase);
    if (req.method === "GET" && url.pathname === this.metadataPath()) return this.metadata(res);
    if (req.method === "POST" && url.pathname === "/register" && this.options.registration !== false) return this.register(req, res);
    if (req.method === "GET" && url.pathname === "/authorize") return this.authorize(url.searchParams, res);
    if (req.method === "POST" && url.pathname === "/token") return this.token(req, res);
    json(res, 404, { error: "not_found" });
  }

  private metadata(res: http.ServerResponse): void {
    const pkce = this.options.pkceMethods === undefined ? ["S256"] : this.options.pkceMethods;
    json(res, 200, {
      issuer: this.options.wrongIssuer === true ? "http://evil.fake.test" : this.issuer,
      authorization_endpoint: `${this.publicBase}/authorize`,
      token_endpoint: `${this.publicBase}/token`,
      ...(this.options.registration === false ? {} : { registration_endpoint: `${this.publicBase}/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp:tools", "offline_access"],
      ...(pkce === null ? {} : { code_challenge_methods_supported: pkce }),
      authorization_response_iss_parameter_supported: true,
    });
  }

  private register(req: Recorded, res: http.ServerResponse): void {
    const body = JSON.parse(req.body) as { redirect_uris?: unknown };
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (redirects.length === 0) return json(res, 400, { error: "invalid_redirect_uri" });
    const clientId = token("client");
    this.clients.set(clientId, redirects);
    this.issued.clientIds.push(clientId);
    json(res, 201, { client_id: clientId, client_id_issued_at: 1, redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  }

  private authorize(params: URLSearchParams, res: http.ServerResponse): void {
    const clientId = params.get("client_id") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state");
    const challenge = params.get("code_challenge");
    const resource = params.get("resource");
    const registered = this.clients.get(clientId);
    if (registered === undefined || !registered.includes(redirectUri)) return void res.writeHead(400).end("invalid_client or redirect_uri");
    if (params.get("response_type") !== "code" || state === null) return void res.writeHead(400).end("invalid_request");
    if (challenge === null || params.get("code_challenge_method") !== "S256") return void res.writeHead(400).end("pkce_required");
    if (resource === null) return void res.writeHead(400).end("invalid_target");
    const code = token("code");
    this.codes.set(code, { clientId, redirectUri, challenge, resource, used: false });
    this.issued.codes.push(code);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    const iss = this.options.issInResponse ?? "correct";
    if (iss !== "absent") target.searchParams.set("iss", iss === "wrong" ? "http://evil.fake.test" : this.issuer);
    res.writeHead(302, { location: target.toString() }).end();
  }

  private token(req: Recorded, res: http.ServerResponse): void {
    const body = Object.fromEntries(new URLSearchParams(req.body).entries());
    const fail = (error: string): void => json(res, 400, { error, error_description: "refused by the fake server" });
    let clientId: string;
    let resource: string;
    if (body.grant_type === "authorization_code") {
      const code = this.codes.get(body.code ?? "");
      if (code === undefined || code.used) return fail("invalid_grant");
      if (code.clientId !== body.client_id || code.redirectUri !== body.redirect_uri) return fail("invalid_grant");
      if (body.code_verifier === undefined || s256(body.code_verifier) !== code.challenge) return fail("invalid_grant");
      if (body.resource !== code.resource) return fail("invalid_target");
      code.used = true;
      clientId = code.clientId;
      resource = code.resource;
    } else if (body.grant_type === "refresh_token") {
      const held = this.refresh.get(body.refresh_token ?? "");
      if (held === undefined || held.clientId !== body.client_id) return fail("invalid_grant");
      if (body.resource !== held.resource) return fail("invalid_target");
      // Public clients: the refresh token rotates on every use.
      this.refresh.delete(body.refresh_token ?? "");
      clientId = held.clientId;
      resource = held.resource;
    } else {
      return fail("unsupported_grant_type");
    }
    const accessToken = token("access");
    const refreshToken = token("refresh");
    this.access.set(accessToken, resource);
    this.refresh.set(refreshToken, { clientId, resource });
    this.issued.accessTokens.push(accessToken);
    this.issued.refreshTokens.push(refreshToken);
    json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: this.options.expiresIn ?? 3600, refresh_token: refreshToken, scope: "mcp:tools" });
  }
}

export interface FakeOAuthMcpOptions {
  /** Where the protected-resource metadata is served. Default the path-aware URL. */
  readonly prmAt?: "path" | "root" | "none";
  /** Put `resource_metadata` in the 401 challenge. Default true. */
  readonly challengeMetadata?: boolean;
  /** Override the metadata's `resource` (a mismatch test). */
  readonly prmResource?: string;
  /** Answer every request with a 307 to this URL. */
  readonly redirectTo?: string;
}

/** A JSON-response Streamable HTTP MCP server that requires a bearer its authorization server issued for it. */
export class FakeOAuthMcp {
  readonly publicBase = `http://${MCP_HOST}`;
  readonly url = `${this.publicBase}/mcp`;
  private readonly listener = new Listener((req, res) => this.route(req, res));

  constructor(
    private readonly auth: FakeAuthServer,
    private readonly options: FakeOAuthMcpOptions = {},
  ) {}

  get port(): number {
    return this.listener.port;
  }
  get requests(): Recorded[] {
    return this.listener.requests;
  }
  /** Requests to the MCP endpoint itself (not metadata). */
  get mcpRequests(): Recorded[] {
    return this.requests.filter((r) => r.path === "/mcp");
  }
  get prmPath(): string {
    return this.options.prmAt === "root" ? "/.well-known/oauth-protected-resource" : "/.well-known/oauth-protected-resource/mcp";
  }

  start(): Promise<void> {
    return this.listener.start();
  }
  stop(): Promise<void> {
    return this.listener.stop();
  }

  private route(req: Recorded, res: http.ServerResponse): void {
    if (this.options.redirectTo !== undefined) return void res.writeHead(307, { location: this.options.redirectTo }).end();
    if (req.method === "GET" && req.path === this.prmPath && this.options.prmAt !== "none") {
      return json(res, 200, { resource: this.options.prmResource ?? this.url, authorization_servers: [this.auth.issuer], scopes_supported: ["mcp:tools"], bearer_methods_supported: ["header"] });
    }
    if (req.path !== "/mcp") return json(res, 404, { error: "not_found" });
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (bearer === undefined || !this.auth.accepts(bearer, this.url)) {
      const metadata = this.options.challengeMetadata === false ? "" : `resource_metadata="${this.publicBase}${this.prmPath}", `;
      return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer ${metadata}scope="mcp:tools"` });
    }
    if (req.method !== "POST") return void res.writeHead(405).end();
    const message = JSON.parse(req.body) as { id?: number | string; method: string; params?: Record<string, unknown> };
    if (message.id === undefined) return void res.writeHead(202).end();
    json(res, 200, { jsonrpc: "2.0", id: message.id, result: answer(message.method, message.params ?? {}) });
  }
}

function answer(method: string, params: Record<string, unknown>): unknown {
  if (method === "initialize") return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-oauth-mcp", version: "1.0.0" } };
  if (method === "tools/list") return { tools: [{ name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
  if (method === "tools/call") return { content: [{ type: "text", text: `echo: ${String((params.arguments as { text?: unknown } | undefined)?.text ?? "")}` }] };
  return {};
}

/** A fetch that sends each public name to its 127.0.0.1 port and never follows a redirect. */
export function routingFetch(routes: Readonly<Record<string, number>>): typeof fetch {
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const port = routes[url.host];
    if (port === undefined) throw new TypeError(`fetch failed: no route to ${url.host}`);
    const target = new URL(url.toString());
    target.protocol = "http:";
    target.host = `127.0.0.1:${port}`;
    return fetch(target, { ...init, redirect: "manual" });
  };
  return impl as typeof fetch;
}

/** What a browser does with the authorization URL: follow the one redirect to the loopback listener. */
export async function fakeBrowser(url: string, routes: Readonly<Record<string, number>>): Promise<number> {
  const first = await routingFetch(routes)(url);
  const location = first.headers.get("location");
  if (location === null) return first.status;
  return (await fetch(location)).status;
}
