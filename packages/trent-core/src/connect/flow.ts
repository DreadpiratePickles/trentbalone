/**
 * The `trent connect` flows over the store: the loopback OAuth connect, the refresh, and the
 * api_key and basic writes. Each returns a `ConnectResult`, which is what the CLI prints and
 * what the doctor reads, and which therefore carries names, scopes and an expiry and never a
 * value. Errors are `TrentError`s with the exit code a script can branch on: CONFIG when the
 * user has not registered the app, AUTH when the authorization did not complete, PROVIDER when
 * the token endpoint refused, USAGE when the provider has no such flow.
 */
import { EXIT, TrentError } from "../errors/index.js";
import { startLoopback } from "./loopback.js";
import {
  buildAuthorizationUrl,
  exchangeCode,
  exchangeLongLived,
  pkcePair,
  randomUrlToken,
  refreshWithToken,
  type FetchLike,
  type TokenRequestInput,
  type TokenResponse,
} from "./oauth.js";
import { connectProvider, type ConnectAuthKind, type ConnectProvider, type ConnectProviderId, type OAuthEndpoints, type OAuthSpec } from "./providers.js";
import type { ConnectStore } from "./store.js";

/** What a connect, refresh or remove reports. No field of this type is a value. */
export interface ConnectResult {
  readonly provider: ConnectProviderId;
  readonly name: string;
  readonly kind: ConnectAuthKind;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  readonly hasRefreshToken: boolean;
  /** oauth2 only: the exact redirect URI the flow used, for the console registration. */
  readonly redirectUri?: string;
  /** Env names written, so the user knows what `trent config get` will now answer `[set]` for. */
  readonly written: readonly string[];
}

export interface OAuthFlowDeps {
  readonly fetchImpl?: FetchLike;
  /** Open the authorization URL. The default caller prints it when this throws or is absent. */
  readonly openBrowser?: (url: string) => void | Promise<void>;
  /** Called with the URL before the browser opens, so a CLI can show it for a manual copy. */
  readonly onAuthorizationUrl?: (url: string) => void;
  readonly now?: () => Date;
  /** Loopback port; 0 (the default) picks a free one. */
  readonly port?: number;
  /** How long to wait for the browser. Default five minutes. */
  readonly timeoutMs?: number;
  /** Endpoint override; a test points it at a local authorization server. */
  readonly endpoints?: OAuthEndpoints;
}

export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

function oauthSpec(provider: ConnectProvider, operation: string): OAuthSpec {
  if (provider.oauth === undefined) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation,
      message: `${provider.name} uses ${provider.kind.replace("_", " ")} credentials, not OAuth; run trent connect ${provider.id} to enter them`,
      target: provider.id,
    });
  }
  return provider.oauth;
}

/** The client id and secret the user registered, or a CONFIG error naming the env names. */
function appCredentials(store: ConnectStore, provider: ConnectProvider, operation: string): { clientId: string; clientSecret?: string } {
  const [idField, secretField] = provider.fields;
  if (idField === undefined || secretField === undefined) throw new Error(`${provider.id} declares no app credential fields`);
  const clientId = store.field(provider.id, idField.env);
  const clientSecret = store.field(provider.id, secretField.env);
  const missing = [idField, secretField].filter((f) => f.required && store.field(provider.id, f.env) === undefined).map((f) => f.env);
  if (clientId === undefined || missing.length > 0) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation,
      message: `${provider.name} needs the app you registered at ${provider.registration.console}: set ${missing.join(" and ")} with trent config set <NAME> <value>`,
      target: provider.id,
    });
  }
  return { clientId, ...(clientSecret === undefined ? {} : { clientSecret }) };
}

function requestInput(store: ConnectStore, provider: ConnectProvider, spec: OAuthSpec, deps: OAuthFlowDeps, operation: string): TokenRequestInput {
  return {
    provider,
    spec,
    endpoints: deps.endpoints ?? spec.endpoints,
    ...appCredentials(store, provider, operation),
    fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? (() => new Date()),
  };
}

function storeAndReport(store: ConnectStore, provider: ConnectProvider, spec: OAuthSpec, token: TokenResponse, fallbackScopes: readonly string[], redirectUri?: string): ConnectResult {
  const scopes = token.scopes ?? fallbackScopes;
  store.writeTokens(provider.id, {
    accessToken: token.accessToken,
    ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
    ...(token.expiresAt === undefined ? {} : { expiresAt: token.expiresAt }),
    scopes,
  });
  const record = store.read(provider.id);
  const t = spec.tokenEnv;
  return {
    provider: provider.id,
    name: provider.name,
    kind: provider.kind,
    scopes: record.scopes,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    hasRefreshToken: record.hasRefreshToken,
    ...(redirectUri === undefined ? {} : { redirectUri }),
    written: [t.access, ...(record.hasRefreshToken ? [t.refresh] : []), t.expiresAt, t.scopes],
  };
}

/**
 * The loopback flow: listen, open the browser, wait for the one callback that echoes our state,
 * exchange the code with the same redirect URI and the PKCE verifier, store, report.
 */
export async function connectOAuth(store: ConnectStore, id: ConnectProviderId, deps: OAuthFlowDeps = {}): Promise<ConnectResult> {
  const provider = connectProvider(id);
  const operation = `connect.${id}`;
  const spec = oauthSpec(provider, operation);
  const input = requestInput(store, provider, spec, deps, operation);
  const state = randomUrlToken();
  const pkce = spec.pkce ? pkcePair() : undefined;

  const listener = await startLoopback({
    providerName: provider.name,
    redirectHost: spec.redirectHost,
    port: deps.port ?? 0,
    expectedState: state,
  });
  try {
    const url = buildAuthorizationUrl(provider, spec, {
      clientId: input.clientId,
      redirectUri: listener.redirectUri,
      state,
      ...(pkce === undefined ? {} : { codeChallenge: pkce.challenge }),
      endpoints: input.endpoints,
    });
    deps.onAuthorizationUrl?.(url);
    // Not awaited: a browser opener that blocks until the tab closes would deadlock the wait.
    void Promise.resolve()
      .then(() => deps.openBrowser?.(url))
      .catch(() => undefined);
    const code = await listener.waitForCode(deps.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS);
    const token = await exchangeCode(input, code, listener.redirectUri, pkce?.verifier);
    return storeAndReport(store, provider, spec, token, provider.scopes, listener.redirectUri);
  } finally {
    await listener.close();
  }
}

/** Renew the stored token now: a refresh grant, or Meta's long-lived exchange. */
export async function refreshOAuth(store: ConnectStore, id: ConnectProviderId, deps: OAuthFlowDeps = {}): Promise<ConnectResult> {
  const provider = connectProvider(id);
  const operation = `connect.${id}.refresh`;
  const spec = oauthSpec(provider, operation);
  const stored = store.tokens(id);
  if (stored === undefined) {
    throw new TrentError({ code: EXIT.AUTH, operation, message: `${provider.name} is not connected; run trent connect ${id}`, target: id });
  }
  const input = requestInput(store, provider, spec, deps, operation);

  if (spec.refresh === "exchange_long_lived") {
    const token = await exchangeLongLived(input, stored.accessToken);
    return storeAndReport(store, provider, spec, token, stored.scopes);
  }
  if (stored.refreshToken === undefined) {
    throw new TrentError({
      code: EXIT.AUTH,
      operation,
      message: `${provider.name} issued no refresh token; run trent connect ${id} to authorize again`,
      target: id,
    });
  }
  const token = await refreshWithToken(input, stored.refreshToken);
  return storeAndReport(store, provider, spec, token, stored.scopes);
}

/** api_key and basic providers: write the values the caller collected (prompt or env). */
export function connectFields(store: ConnectStore, id: ConnectProviderId, values: Readonly<Record<string, string>>): ConnectResult {
  const provider = connectProvider(id);
  const operation = `connect.${id}`;
  if (provider.kind === "oauth2") {
    throw new TrentError({ code: EXIT.USAGE, operation, message: `${provider.name} connects over OAuth; app credentials go through trent config set`, target: id });
  }
  try {
    store.writeFields(id, values);
  } catch (err) {
    throw new TrentError({ code: EXIT.USAGE, operation, message: err instanceof Error ? err.message : String(err), target: id });
  }
  const record = store.read(id);
  if (!record.connected) {
    throw new TrentError({ code: EXIT.USAGE, operation, message: `${provider.name} still needs ${record.missing.join(" and ")}`, target: id });
  }
  return {
    provider: id,
    name: provider.name,
    kind: provider.kind,
    scopes: [],
    hasRefreshToken: false,
    written: Object.keys(values),
  };
}
