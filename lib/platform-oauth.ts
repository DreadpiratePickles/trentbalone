import { createHash, randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "@/lib/secrets";
import {
  discoverMetaAdAccount,
  discoverMetaSocialAccount,
  type MetaOAuthResolvedAccount,
} from "@/lib/platform-oauth-meta";
import {
  saveMarketingPlatformConnection,
  saveSocialPlatformConnection,
} from "@/lib/platform-connections";
import { store } from "@/lib/store";
import type { MarketingPlatform, SocialPlatform, ToolConnection } from "@/lib/types";

export type PlatformOAuthKind = "social" | "ads";
export type PlatformOAuthPlatform = SocialPlatform | MarketingPlatform;

export type PlatformOAuthStartInput = {
  companyId: string;
  kind: PlatformOAuthKind;
  platform: PlatformOAuthPlatform;
  redirectUri: string;
  externalAccountId?: string;
  externalHandle?: string;
  displayName?: string;
};

export type PlatformOAuthStart = {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  provider: string;
  scopes: string[];
};

export type PlatformOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  scope?: string;
  open_id?: string;
  id?: string;
  user_id?: string;
  account_id?: string;
};

export type PlatformOAuthExchangeInput = {
  code: string;
  state: string;
  fetchImpl?: typeof fetch;
};

export type PlatformOAuthRefreshInput = {
  companyId: string;
  kind: PlatformOAuthKind;
  platform: PlatformOAuthPlatform;
  fetchImpl?: typeof fetch;
};

type PlatformOAuthState = PlatformOAuthStartInput & {
  createdAt: string;
  codeVerifier: string;
};

type OAuthProviderConfig = {
  provider: string;
  clientIdEnv: string;
  clientSecretEnv?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  clientIdParam: "client_id" | "client_key";
  refreshClientIdParam: "client_id" | "client_key";
};

const OAUTH_CONFIGS = {
  tiktok: {
    provider: "Social:TikTok",
    clientIdEnv: "TIKTOK_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_CLIENT_SECRET",
    authorizationEndpoint: "https://www.tiktok.com/v2/auth/authorize/",
    tokenEndpoint: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.upload"],
    clientIdParam: "client_key",
    refreshClientIdParam: "client_key",
  },
  instagram: {
    provider: "Social:Instagram",
    clientIdEnv: "META_CLIENT_ID",
    clientSecretEnv: "META_CLIENT_SECRET",
    authorizationEndpoint: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenEndpoint: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
  facebook: {
    provider: "Social:Facebook",
    clientIdEnv: "META_CLIENT_ID",
    clientSecretEnv: "META_CLIENT_SECRET",
    authorizationEndpoint: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenEndpoint: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_manage_metadata"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
  youtube: {
    provider: "Social:YouTube",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
  x: {
    provider: "Social:X",
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    authorizationEndpoint: "https://x.com/i/oauth2/authorize",
    tokenEndpoint: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
  linkedin: {
    provider: "Social:LinkedIn",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authorizationEndpoint: "https://www.linkedin.com/oauth/v2/authorization",
    tokenEndpoint: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social", "r_organization_social", "w_organization_social"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
  meta: {
    provider: "Ads:Meta",
    clientIdEnv: "META_CLIENT_ID",
    clientSecretEnv: "META_CLIENT_SECRET",
    authorizationEndpoint: "https://www.facebook.com/v20.0/dialog/oauth",
    tokenEndpoint: "https://graph.facebook.com/v20.0/oauth/access_token",
    scopes: ["ads_management", "ads_read", "business_management"],
    clientIdParam: "client_id",
    refreshClientIdParam: "client_id",
  },
} satisfies Record<string, OAuthProviderConfig>;

export function buildPlatformOAuthStart(input: PlatformOAuthStartInput): PlatformOAuthStart {
  const config = configFor(input.kind, input.platform);
  const clientId = envValue(config.clientIdEnv);
  const codeVerifier = randomToken(64);
  const state = encryptJson({
    ...input,
    createdAt: new Date().toISOString(),
    codeVerifier,
  } satisfies PlatformOAuthState);
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set(config.clientIdParam, clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (input.platform === "youtube") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return {
    authorizationUrl: url.toString(),
    state,
    codeVerifier,
    provider: config.provider,
    scopes: config.scopes,
  };
}

export function readPlatformOAuthState(state: string): Pick<PlatformOAuthState, "companyId" | "kind" | "platform"> {
  const parsed = decryptJson<PlatformOAuthState>(state);
  return {
    companyId: parsed.companyId,
    kind: parsed.kind,
    platform: parsed.platform,
  };
}

export async function exchangePlatformOAuthCode(input: PlatformOAuthExchangeInput) {
  const state = decryptJson<PlatformOAuthState>(input.state);
  const config = configFor(state.kind, state.platform);
  const token = await requestToken(config, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: state.redirectUri,
    code_verifier: state.codeVerifier,
  }, input.fetchImpl);
  const accessToken = requireAccessToken(token);
  const resolvedAccount = await resolveOAuthAccount({
    config,
    state,
    token,
    accessToken,
    fetchImpl: input.fetchImpl,
  });
  if (!resolvedAccount) {
    throw new Error("OAuth callback could not determine externalAccountId; provide one at start or complete account picker first.");
  }
  const saved = state.kind === "ads"
    ? await saveMarketingPlatformConnection(state.companyId, {
        platform: state.platform as MarketingPlatform,
        accessToken: resolvedAccount.accessToken ?? accessToken,
        refreshToken: token.refresh_token,
        tokenExpiresAt: expiresAt(token.expires_in),
        refreshTokenExpiresAt: expiresAt(token.refresh_expires_in),
        externalAccountId: resolvedAccount.externalAccountId,
        externalBusinessId: resolvedAccount.externalBusinessId,
        currency: resolvedAccount.currency,
      })
    : await saveSocialPlatformConnection(state.companyId, {
        platform: state.platform as SocialPlatform,
        accessToken: resolvedAccount.accessToken ?? accessToken,
        refreshToken: token.refresh_token,
        tokenExpiresAt: expiresAt(token.expires_in),
        refreshTokenExpiresAt: expiresAt(token.refresh_expires_in),
        externalAccountId: resolvedAccount.externalAccountId,
        externalHandle: resolvedAccount.externalHandle ?? state.externalHandle,
        displayName: resolvedAccount.displayName ?? state.displayName,
        scopes: parseScopes(token.scope, config.scopes),
      });
  return {
    status: "connected" as const,
    platform: state.platform,
    kind: state.kind,
    account: saved.account,
    safeConnection: redactConnection(saved.connection),
  };
}

export async function refreshPlatformOAuthConnection(input: PlatformOAuthRefreshInput) {
  const config = configFor(input.kind, input.platform);
  const connection = await store.getIntegration(input.companyId, config.provider);
  if (!connection?.encryptedData) throw new Error(`${config.provider} is not connected`);
  const credentials = decryptJson<{
    kind: PlatformOAuthKind;
    platform: PlatformOAuthPlatform;
    accessToken: string;
    refreshToken?: string;
    externalAccountId: string;
    scopes?: string[];
  }>(connection.encryptedData);
  if (!credentials.refreshToken) throw new Error(`${config.provider} has no refresh token`);

  const token = await requestToken(config, {
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  }, input.fetchImpl);
  const refreshed = input.kind === "ads"
    ? await saveMarketingPlatformConnection(input.companyId, {
        platform: input.platform as MarketingPlatform,
        accessToken: requireAccessToken(token),
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        tokenExpiresAt: expiresAt(token.expires_in),
        refreshTokenExpiresAt: expiresAt(token.refresh_expires_in),
        externalAccountId: credentials.externalAccountId,
      })
    : await saveSocialPlatformConnection(input.companyId, {
        platform: input.platform as SocialPlatform,
        accessToken: requireAccessToken(token),
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        tokenExpiresAt: expiresAt(token.expires_in),
        refreshTokenExpiresAt: expiresAt(token.refresh_expires_in),
        externalAccountId: credentials.externalAccountId,
        scopes: parseScopes(token.scope, credentials.scopes ?? config.scopes),
      });
  return {
    status: "refreshed" as const,
    platform: input.platform,
    kind: input.kind,
    safeConnection: redactConnection(refreshed.connection),
  };
}

async function requestToken(
  config: OAuthProviderConfig,
  params: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformOAuthTokenResponse> {
  const body = new URLSearchParams();
  body.set(config.refreshClientIdParam, envValue(config.clientIdEnv));
  const clientSecret = config.clientSecretEnv ? process.env[config.clientSecretEnv] : undefined;
  if (clientSecret) body.set("client_secret", clientSecret);
  for (const [key, value] of Object.entries(params)) {
    if (value) body.set(key, value);
  }
  const response = await fetchImpl(config.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth token request failed (${response.status}): ${scrubProviderSecrets(text, config)}`);
  }
  return await response.json() as PlatformOAuthTokenResponse;
}

function configFor(kind: PlatformOAuthKind, platform: PlatformOAuthPlatform): OAuthProviderConfig {
  if (kind === "ads" && platform !== "meta") throw new Error(`Ads OAuth is not configured for ${platform}`);
  const config = OAUTH_CONFIGS[platform as keyof typeof OAUTH_CONFIGS];
  if (!config) throw new Error(`OAuth is not configured for ${platform}`);
  return kind === "ads" ? { ...config, provider: "Ads:Meta" } : config;
}

function requireAccessToken(token: PlatformOAuthTokenResponse) {
  if (!token.access_token) throw new Error("OAuth token response missing access_token");
  return token.access_token;
}

function externalAccountFromToken(token: PlatformOAuthTokenResponse, fallback?: string) {
  return fallback || token.open_id || token.account_id || token.user_id || token.id;
}

async function resolveOAuthAccount(input: {
  config: OAuthProviderConfig;
  state: PlatformOAuthState;
  token: PlatformOAuthTokenResponse;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<MetaOAuthResolvedAccount | undefined> {
  const fromToken = externalAccountFromToken(input.token, input.state.externalAccountId);
  if (fromToken) return { externalAccountId: fromToken };
  if (input.state.kind === "social" && (input.state.platform === "facebook" || input.state.platform === "instagram")) {
    return discoverMetaSocialAccount({
      platform: input.state.platform,
      accessToken: input.accessToken,
      config: input.config,
      fetchImpl: input.fetchImpl ?? fetch,
    });
  }
  if (input.state.kind === "ads" && input.state.platform === "meta") {
    return discoverMetaAdAccount({
      accessToken: input.accessToken,
      config: input.config,
      fetchImpl: input.fetchImpl ?? fetch,
    });
  }
  return undefined;
}

function parseScopes(scope: string | undefined, fallback: string[]) {
  if (!scope) return fallback;
  return scope.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function expiresAt(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return undefined;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function redactConnection(connection: ToolConnection) {
  const { encryptedData: _encryptedData, ...safe } = connection;
  return safe;
}

function envValue(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function randomToken(bytes: number) {
  return randomBytes(bytes).toString("base64url").slice(0, bytes);
}

function codeChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function scrubProviderSecrets(text: string, config: OAuthProviderConfig, extraSecrets: string[] = []) {
  let scrubbed = text;
  for (const key of [config.clientIdEnv, config.clientSecretEnv].filter((item): item is string => Boolean(item))) {
    const value = process.env[key];
    if (value && value.length >= 8) scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  for (const value of extraSecrets) {
    if (value.length >= 8) scrubbed = scrubbed.split(value).join("[REDACTED]");
  }
  return scrubbed;
}
