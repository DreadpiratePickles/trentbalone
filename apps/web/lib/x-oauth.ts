/**
 * X (Twitter) OAuth 2.0 user-context token refresh.
 *
 * X access tokens expire after ~2h and the refresh token rotates on every use
 * (offline.access). A static `X_USER_ACCESS_TOKEN` therefore goes 401 quickly.
 * This module exchanges `X_REFRESH_TOKEN` (+ client credentials) for a fresh
 * access token so seat tools and `providers:proof` can stay green.
 */

type EnvLike = Pick<NodeJS.ProcessEnv, string>;
type FetchLike = typeof fetch;

const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";

export type XRefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
};

export function xClientId(env: EnvLike): string | undefined {
  return firstNonEmpty(env.X_CLIENT_ID, env.TWITTER_CLIENT_ID);
}

export function xClientSecret(env: EnvLike): string | undefined {
  return firstNonEmpty(env.X_CLIENT_SECRET, env.TWITTER_CLIENT_SECRET);
}

export function xRefreshToken(env: EnvLike): string | undefined {
  return firstNonEmpty(env.X_REFRESH_TOKEN, env.TWITTER_REFRESH_TOKEN);
}

/** True when an OAuth2 refresh can be attempted (client id + refresh token present). */
export function xRefreshConfigured(env: EnvLike): boolean {
  return Boolean(xClientId(env) && xRefreshToken(env));
}

export async function refreshXAccessToken(
  env: EnvLike,
  fetchImpl: FetchLike = fetch,
): Promise<XRefreshResult> {
  const clientId = xClientId(env);
  const refreshToken = xRefreshToken(env);
  if (!clientId || !refreshToken) {
    throw new Error(
      "X OAuth2 refresh requires X_CLIENT_ID and X_REFRESH_TOKEN (with offline.access scope).",
    );
  }
  const clientSecret = xClientSecret(env);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  // Confidential clients authenticate with HTTP Basic; public clients send client_id only.
  if (clientSecret) {
    headers.Authorization = `Basic ${base64(`${clientId}:${clientSecret}`)}`;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const response = await fetchImpl(X_TOKEN_URL, { method: "POST", headers, body });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = readString(json.error_description) ?? readString(json.error) ?? "unknown error";
    throw new Error(`X token refresh failed (${response.status}): ${detail}`);
  }
  const accessToken = readString(json.access_token);
  if (!accessToken) {
    throw new Error("X token refresh returned no access_token.");
  }
  return {
    accessToken,
    refreshToken: readString(json.refresh_token),
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : undefined,
    scope: readString(json.scope),
  };
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
