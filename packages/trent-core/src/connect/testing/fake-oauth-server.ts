/**
 * A local OAuth 2.0 authorization server for the `connect` wire tests, speaking just enough of
 * RFC 6749 and RFC 7636 to check what the client sent: the authorization endpoint issues a code
 * bound to the redirect URI and the PKCE challenge, and the token endpoint verifies the code,
 * the exact redirect URI, the verifier, the client credentials and the grant type before it
 * answers. Every request is recorded so a test can assert the bytes, and every token it mints is
 * listed in `issued` so a test can prove none of them reached an output.
 *
 * The knobs (`tamperState`, `denyNext`, `refuseTokens`) make it misbehave one way at a time.
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOAuthOptions {
  readonly clientId: string;
  /** When set, every token request must carry it or is refused as `invalid_client`. */
  readonly clientSecret?: string;
  /** Require a PKCE challenge at authorization and its verifier at exchange. Default true. */
  readonly requirePkce?: boolean;
  /** Seconds the issued access token lives. Default 3600. */
  readonly expiresIn?: number;
  /** Answer Square-style, with an `expires_at` ISO timestamp instead of `expires_in`. */
  readonly expiresAtIso?: boolean;
  /** Echo the granted scopes in the token response (RFC 6749 section 5.1). Default true. */
  readonly scopeInResponse?: boolean;
  /** Issue a new refresh token on every refresh grant. Default false. */
  readonly rotateRefresh?: boolean;
}

export interface RecordedTokenRequest {
  readonly contentType: string;
  readonly body: Readonly<Record<string, string>>;
}

interface IssuedCode {
  readonly redirectUri: string;
  readonly challenge?: string;
  readonly scope: string;
  used: boolean;
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class FakeOAuthServer {
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: RecordedTokenRequest[] = [];
  readonly issued = { codes: [] as string[], accessTokens: [] as string[], refreshTokens: [] as string[] };
  /** The next authorization redirect carries a state the client never sent. */
  tamperState = false;
  /** The next authorization redirect carries `error=access_denied` and no code. */
  denyNext = false;
  /** The token endpoint answers 400 `invalid_grant` to everything. */
  refuseTokens = false;

  private readonly codes = new Map<string, IssuedCode>();
  private readonly refreshTokens = new Set<string>();
  private readonly accessTokens = new Set<string>();
  private server?: http.Server;
  private base = "";

  constructor(private readonly options: FakeOAuthOptions) {}

  get endpoints(): { authorization: string; token: string } {
    return { authorization: `${this.base}/authorize`, token: `${this.base}/token` };
  }

  get refreshCount(): number {
    return this.tokenRequests.filter((r) => r.body.grant_type === "refresh_token").length;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  /** Register a token as if issued earlier, so a refresh or exchange test can start from it. */
  seed(tokens: { accessToken?: string; refreshToken?: string }): void {
    if (tokens.accessToken !== undefined) this.accessTokens.add(tokens.accessToken);
    if (tokens.refreshToken !== undefined) this.refreshTokens.add(tokens.refreshToken);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    if (req.method === "GET" && url.pathname === "/authorize") return this.authorize(url.searchParams, res);
    if (req.method === "POST" && url.pathname === "/token") return this.token(req, res);
    res.writeHead(404).end();
  }

  private authorize(params: URLSearchParams, res: http.ServerResponse): void {
    this.authorizeRequests.push(params);
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    if (params.get("response_type") !== "code" || params.get("client_id") !== this.options.clientId || redirectUri === null || state === null) {
      res.writeHead(400, { "content-type": "text/plain" }).end("invalid_request");
      return;
    }
    const challenge = params.get("code_challenge");
    if ((this.options.requirePkce ?? true) && (challenge === null || params.get("code_challenge_method") !== "S256")) {
      res.writeHead(400, { "content-type": "text/plain" }).end("pkce_required");
      return;
    }
    const target = new URL(redirectUri);
    if (this.denyNext) {
      this.denyNext = false;
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("state", state);
    } else {
      const code = token("code");
      this.codes.set(code, { redirectUri, ...(challenge === null ? {} : { challenge }), scope: params.get("scope") ?? "", used: false });
      this.issued.codes.push(code);
      target.searchParams.set("code", code);
      target.searchParams.set("state", this.tamperState ? `${state}-tampered` : state);
      this.tamperState = false;
    }
    res.writeHead(302, { location: target.toString() }).end();
  }

  private async token(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const contentType = String(req.headers["content-type"] ?? "");
    const body: Record<string, string> = contentType.includes("application/json")
      ? Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : Object.fromEntries(new URLSearchParams(raw).entries());
    this.tokenRequests.push({ contentType, body });

    const fail = (status: number, error: string): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error, error_description: "refused by the fake server" }));
    };
    if (this.refuseTokens) return fail(400, "invalid_grant");
    if (body.client_id !== this.options.clientId) return fail(401, "invalid_client");
    if (this.options.clientSecret !== undefined && body.client_secret !== this.options.clientSecret) return fail(401, "invalid_client");

    let scope = "";
    let refreshToken: string | undefined;
    let expiresIn = this.options.expiresIn ?? 3600;
    if (body.grant_type === "authorization_code") {
      const issued = this.codes.get(body.code ?? "");
      if (issued === undefined || issued.used) return fail(400, "invalid_grant");
      if (issued.redirectUri !== body.redirect_uri) return fail(400, "invalid_grant");
      if (issued.challenge !== undefined && (body.code_verifier === undefined || s256(body.code_verifier) !== issued.challenge)) return fail(400, "invalid_grant");
      issued.used = true;
      scope = issued.scope;
      refreshToken = token("refresh");
      this.refreshTokens.add(refreshToken);
      this.issued.refreshTokens.push(refreshToken);
    } else if (body.grant_type === "refresh_token") {
      if (!this.refreshTokens.has(body.refresh_token ?? "")) return fail(400, "invalid_grant");
      if (this.options.rotateRefresh === true) {
        this.refreshTokens.delete(body.refresh_token ?? "");
        refreshToken = token("refresh");
        this.refreshTokens.add(refreshToken);
        this.issued.refreshTokens.push(refreshToken);
      }
    } else if (body.grant_type === "fb_exchange_token") {
      if (!this.accessTokens.has(body.fb_exchange_token ?? "")) return fail(400, "invalid_grant");
      expiresIn = 60 * 24 * 60 * 60;
    } else {
      return fail(400, "unsupported_grant_type");
    }

    const accessToken = token("access");
    this.accessTokens.add(accessToken);
    this.issued.accessTokens.push(accessToken);
    const payload: Record<string, unknown> = { access_token: accessToken, token_type: "Bearer" };
    if (this.options.expiresAtIso === true) payload.expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();
    else payload.expires_in = expiresIn;
    if (refreshToken !== undefined) payload.refresh_token = refreshToken;
    if ((this.options.scopeInResponse ?? true) && scope !== "") payload.scope = scope;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  }
}

/** What a browser does with the authorization URL: follow the redirect to the loopback. */
export async function fakeBrowser(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { redirect: "follow" });
  return { status: res.status, body: await res.text() };
}
