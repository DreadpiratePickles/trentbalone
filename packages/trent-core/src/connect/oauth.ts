/**
 * The OAuth 2.0 wire pieces of `trent connect`: PKCE material (RFC 7636), the authorization
 * URL, and the token endpoint requests for the three grants the registry uses (a code exchange,
 * a refresh, Meta's long-lived exchange). Every request goes through the one `requestToken`
 * below, which is where the rule "a provider's answer is reported by status and error code, and
 * its body is never repeated" is enforced: a body can echo the code or the client secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { EXIT, TrentError } from "../errors/index.js";
import type { ConnectProvider, OAuthEndpoints, OAuthSpec } from "./providers.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** 32 random bytes as base64url: 43 characters, the size RFC 7636 recommends for a verifier. */
export function randomUrlToken(): string {
  return randomBytes(32).toString("base64url");
}

export function pkcePair(): PkcePair {
  const verifier = randomUrlToken();
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthorizationUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** Present when the provider honours PKCE. */
  readonly codeChallenge?: string;
  readonly endpoints: OAuthEndpoints;
}

export function buildAuthorizationUrl(provider: ConnectProvider, spec: OAuthSpec, input: AuthorizationUrlInput): string {
  const url = new URL(input.endpoints.authorization);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes.join(spec.scopeSeparator));
  url.searchParams.set("state", input.state);
  if (spec.pkce && input.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(spec.extraAuthorizationParams)) url.searchParams.set(key, value);
  return url.toString();
}

/** A token endpoint's answer, normalised. `expiresAt` is absolute so the store can compare it. */
export interface TokenResponse {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  /** Scopes the provider reports as granted; absent when it reports none. */
  readonly scopes?: readonly string[];
}

export interface TokenRequestInput {
  readonly provider: ConnectProvider;
  readonly spec: OAuthSpec;
  readonly endpoints: OAuthEndpoints;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly fetchImpl: FetchLike;
  readonly now: () => Date;
}

export function exchangeCode(input: TokenRequestInput, code: string, redirectUri: string, codeVerifier?: string): Promise<TokenResponse> {
  return requestToken(input, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    ...(codeVerifier === undefined ? {} : { code_verifier: codeVerifier }),
  });
}

export function refreshWithToken(input: TokenRequestInput, refreshToken: string): Promise<TokenResponse> {
  return requestToken(input, { grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Meta issues no refresh token; a short-lived user token is exchanged for a long-lived one. */
export function exchangeLongLived(input: TokenRequestInput, accessToken: string): Promise<TokenResponse> {
  return requestToken(input, { grant_type: "fb_exchange_token", fb_exchange_token: accessToken });
}

/** Only an error code shaped like RFC 6749 section 5.2 is repeated; anything else is not. */
const ERROR_CODE = /^[a-z_]{1,40}$/;

async function requestToken(input: TokenRequestInput, params: Readonly<Record<string, string>>): Promise<TokenResponse> {
  const body: Record<string, string> = { client_id: input.clientId, ...params };
  if (input.clientSecret !== undefined) body.client_secret = input.clientSecret;
  const operation = `connect.${input.provider.id}.token`;

  let response: Response;
  try {
    response = await input.fetchImpl(
      input.endpoints.token,
      input.spec.tokenRequest === "json"
        ? { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }
        : { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(body).toString() },
    );
  } catch (err) {
    throw new TrentError({
      code: EXIT.PROVIDER,
      operation,
      message: `the ${input.provider.name} token endpoint could not be reached`,
      target: input.endpoints.token,
      cause: err,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};

  if (!response.ok) {
    const code = typeof record.error === "string" && ERROR_CODE.test(record.error) ? record.error : "no error code";
    throw new TrentError({
      code: EXIT.PROVIDER,
      operation,
      message: `the ${input.provider.name} token endpoint answered ${response.status} (${code})`,
      target: input.endpoints.token,
      context: { status: response.status },
    });
  }

  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new TrentError({
      code: EXIT.PROVIDER,
      operation,
      message: `the ${input.provider.name} token endpoint answered ${response.status} without an access token`,
      target: input.endpoints.token,
    });
  }

  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token !== "" ? record.refresh_token : undefined;
  const expiresAt = expiryOf(record, input.now());
  const scopes = typeof record.scope === "string" ? record.scope.split(/[\s,]+/).filter((s) => s !== "") : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
  };
}

/** `expires_in` seconds (Google, Meta) or `expires_at` ISO (Square), as an absolute instant. */
function expiryOf(record: Record<string, unknown>, now: Date): string | undefined {
  const expiresIn = record.expires_in;
  const seconds = typeof expiresIn === "number" ? expiresIn : typeof expiresIn === "string" ? Number(expiresIn) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) return new Date(now.getTime() + seconds * 1000).toISOString();
  const expiresAt = record.expires_at;
  if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt))) return new Date(expiresAt).toISOString();
  return undefined;
}

// [H2] A token request at an endpoint no registry entry describes: the authorization server an MCP
// server named in its protected-resource metadata (`tools/mcp/http-oauth.ts`). The same rule as
// `requestToken` above: the answer is reported by status and error code, its body never repeated.
// The body is always a form (OAuth 2.1 section 3.2.2); `headers` carries client authentication when
// the registration asked for `client_secret_basic`. Redirects are not followed: a token endpoint that
// redirects would receive the code, the verifier or the refresh token at a host nobody vetted.
export interface TokenEndpointRequest {
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl: FetchLike;
  readonly now: () => Date;
  /** Who answered, for the message: "the authorization server at https://auth.example.com". */
  readonly label: string;
  readonly operation: string;
}

export async function requestTokenAt(input: TokenEndpointRequest): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...input.headers },
      body: new URLSearchParams({ ...input.params }).toString(),
      redirect: "manual",
    });
  } catch (err) {
    throw new TrentError({ code: EXIT.PROVIDER, operation: input.operation, message: `${input.label} could not be reached`, target: input.endpoint, cause: err });
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  if (!response.ok) {
    const code = typeof record.error === "string" && ERROR_CODE.test(record.error) ? record.error : "no error code";
    throw new TrentError({ code: EXIT.PROVIDER, operation: input.operation, message: `${input.label} answered ${response.status} (${code})`, target: input.endpoint, context: { status: response.status } });
  }
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new TrentError({ code: EXIT.PROVIDER, operation: input.operation, message: `${input.label} answered ${response.status} without an access token`, target: input.endpoint });
  }
  const refreshToken = typeof record.refresh_token === "string" && record.refresh_token !== "" ? record.refresh_token : undefined;
  const expiresAt = expiryOf(record, input.now());
  const scopes = typeof record.scope === "string" ? record.scope.split(/[\s,]+/).filter((s) => s !== "") : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(scopes === undefined || scopes.length === 0 ? {} : { scopes }),
  };
}
// [/H2]
