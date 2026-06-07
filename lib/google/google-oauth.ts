import { GOOGLE_DEFAULT_SCOPES, type GoogleCredentials } from "@/lib/google/google-connection";
import { type GoogleFetch } from "@/lib/google/google-client";
import { nowIso } from "@/lib/utils";

// Google OAuth authorization-code flow for the operator connection. The consent
// URL requests offline access so Google returns a long-lived refresh token,
// which is what the connection stores. These functions are inert until the
// operator configures a Google Cloud OAuth app (GOOGLE_CLIENT_ID/SECRET +
// redirect URI). Gmail read+send are restricted scopes and require Google app
// verification before real accounts can grant them.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function buildGoogleConsentUrl(input: { state: string; scopes?: string[] }): string {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
    scope: (input.scopes ?? GOOGLE_DEFAULT_SCOPES).join(" "),
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string, fetchImpl?: GoogleFetch): Promise<GoogleCredentials> {
  const clientId = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = requireEnv("GOOGLE_OAUTH_REDIRECT_URI");
  const doFetch = fetchImpl ?? defaultFetch;

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await doFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (${response.status})`);
  const data = (await response.json()) as { refresh_token?: string; access_token?: string; expires_in?: number; scope?: string };
  if (!data.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke prior access and retry with prompt=consent.");
  }
  return {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : nowIso(),
    scopes: data.scope ? data.scope.split(" ") : GOOGLE_DEFAULT_SCOPES,
  };
}

const defaultFetch: GoogleFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status, json: () => response.json() };
};
