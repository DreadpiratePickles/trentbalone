/**
 * `tokenResolver(provider)`: the one call an adapter makes for a credential it can use now.
 *
 * For an oauth2 provider that means the stored access token, refreshed first when it is inside
 * `REFRESH_WINDOW_MS` of its expiry (or past it), under `withRefreshLock` so racing callers
 * produce one refresh and all read the token it stored. For an api_key provider it is the key;
 * for a basic provider the identifier and the secret. Nothing here prints, logs or serialises a
 * value: the result goes to the adapter that asked and nowhere else.
 *
 * `platformTokenResolver` is the same resolver in the exact shape
 * `apps/web/lib/social/live-platform-adapter.ts` takes as `deps.tokenResolver`, checked by
 * type against that file, so a social toolset passes it through without an adapter of its own.
 */
import type { createLiveSocialAdapter } from "@/lib/social/live-platform-adapter";
import type { SocialPlatform } from "@/lib/social/platform-adapter";
import { ConfigManager } from "../config/ConfigManager.js";
import { EXIT, TrentError } from "../errors/index.js";
import { refreshOAuth } from "./flow.js";
import { withRefreshLock } from "./lock.js";
import type { FetchLike } from "./oauth.js";
import { connectProvider, type ConnectAuthKind, type ConnectProviderId, type OAuthEndpoints } from "./providers.js";
import { ConnectStore, type StoredTokens } from "./store.js";

/** A token inside this window of its expiry is refreshed before it is handed out. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface ResolvedToken {
  readonly provider: ConnectProviderId;
  readonly kind: ConnectAuthKind;
  /** The bearer value for api_key and oauth2 providers; the secret half of a basic pair. */
  readonly accessToken: string;
  /** basic only: the identifier that pairs with the secret (an Account SID, a handle). */
  readonly username?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
  /** True when this call renewed the token before returning it. */
  readonly refreshed: boolean;
}

export interface TokenResolverOptions {
  /** The profile to read. Defaults to the one `TRENT_HOME` and `TRENT_PROFILE` name. */
  readonly manager?: ConfigManager;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** Endpoint overrides per provider; a test points one at a local authorization server. */
  readonly endpoints?: Partial<Record<ConnectProviderId, OAuthEndpoints>>;
}

function needsRefresh(tokens: StoredTokens, now: Date): boolean {
  if (tokens.expiresAt === undefined) return false;
  const expiry = Date.parse(tokens.expiresAt);
  if (!Number.isFinite(expiry)) return false;
  return expiry - now.getTime() <= REFRESH_WINDOW_MS;
}

function expired(tokens: StoredTokens, now: Date): boolean {
  if (tokens.expiresAt === undefined) return false;
  const expiry = Date.parse(tokens.expiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime();
}

async function resolveOAuth(store: ConnectStore, manager: ConfigManager, id: ConnectProviderId, options: TokenResolverOptions): Promise<ResolvedToken> {
  const provider = connectProvider(id);
  const spec = provider.oauth;
  if (spec === undefined) throw new Error(`${id} is not an oauth2 provider`);
  const now = options.now ?? (() => new Date());
  const notConnected = (): TrentError =>
    new TrentError({ code: EXIT.AUTH, operation: `connect.${id}.resolve`, message: `${provider.name} is not connected; run trent connect ${id}`, target: id });

  const first = store.tokens(id);
  if (first === undefined) throw notConnected();
  if (!needsRefresh(first, now())) return { provider: id, kind: "oauth2", accessToken: first.accessToken, ...(first.expiresAt === undefined ? {} : { expiresAt: first.expiresAt }), scopes: first.scopes, refreshed: false };

  return withRefreshLock(manager.getProfileDir(), id, async () => {
    // Re-read under the lock: a peer may have refreshed while this caller waited.
    const tokens = store.tokens(id);
    if (tokens === undefined) throw notConnected();
    const fresh = !needsRefresh(tokens, now());
    const renewable = spec.refresh === "exchange_long_lived" || tokens.refreshToken !== undefined;
    if (fresh || !renewable) {
      if (expired(tokens, now())) {
        throw new TrentError({
          code: EXIT.AUTH,
          operation: `connect.${id}.resolve`,
          message: `the ${provider.name} token expired and cannot be refreshed; run trent connect ${id}`,
          target: id,
        });
      }
      return { provider: id, kind: "oauth2", accessToken: tokens.accessToken, ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }), scopes: tokens.scopes, refreshed: false };
    }
    await refreshOAuth(store, id, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.endpoints?.[id] === undefined ? {} : { endpoints: options.endpoints[id] }),
      now,
    });
    const renewed = store.tokens(id);
    if (renewed === undefined) throw notConnected();
    return { provider: id, kind: "oauth2", accessToken: renewed.accessToken, ...(renewed.expiresAt === undefined ? {} : { expiresAt: renewed.expiresAt }), scopes: renewed.scopes, refreshed: true };
  });
}

export async function tokenResolver(id: ConnectProviderId, options: TokenResolverOptions = {}): Promise<ResolvedToken> {
  const provider = connectProvider(id);
  const manager = options.manager ?? new ConfigManager();
  const store = new ConnectStore(manager);
  if (provider.kind === "oauth2") return resolveOAuth(store, manager, id, options);

  const record = store.read(id);
  if (!record.connected) {
    throw new TrentError({ code: EXIT.AUTH, operation: `connect.${id}.resolve`, message: `${provider.name} is not connected; run trent connect ${id}`, target: id });
  }
  const secretField = provider.fields.find((f) => f.secret);
  const idField = provider.fields.find((f) => !f.secret);
  const accessToken = secretField === undefined ? undefined : store.field(id, secretField.env);
  if (accessToken === undefined) {
    throw new TrentError({ code: EXIT.AUTH, operation: `connect.${id}.resolve`, message: `${provider.name} is not connected; run trent connect ${id}`, target: id });
  }
  const username = idField === undefined ? undefined : store.field(id, idField.env);
  return {
    provider: id,
    kind: provider.kind,
    accessToken,
    ...(provider.kind === "basic" && username !== undefined ? { username } : {}),
    scopes: [],
    refreshed: false,
  };
}

/** The resolver bound to its options, for an adapter that takes a function. */
export function createTokenResolver(options: TokenResolverOptions = {}): (id: ConnectProviderId) => Promise<ResolvedToken> {
  return (id) => tokenResolver(id, options);
}

type LiveAdapterDeps = NonNullable<Parameters<typeof createLiveSocialAdapter>[1]>;

/** Exactly `deps.tokenResolver` of `createLiveSocialAdapter`; the alias is derived, not restated. */
export type PlatformTokenResolver = NonNullable<LiveAdapterDeps["tokenResolver"]>;

/** Which `trent connect` provider holds each social platform's token. Absent means none does. */
export const PLATFORM_PROVIDER: Readonly<Partial<Record<SocialPlatform, ConnectProviderId>>> = {
  facebook: "meta",
  instagram: "meta",
  threads: "meta",
  youtube: "google",
};

/**
 * The adapter's resolver. A platform no provider holds, or one that is not connected, answers
 * `undefined` so the adapter raises its own `needs_credentials`; a refresh that fails throws,
 * because that is a provider answer the caller must see.
 */
export function platformTokenResolver(options: TokenResolverOptions = {}): PlatformTokenResolver {
  return async (input) => {
    const id = PLATFORM_PROVIDER[input.platform];
    if (id === undefined) return undefined;
    const manager = options.manager ?? new ConfigManager();
    const store = new ConnectStore(manager);
    if (!store.read(id).connected) return undefined;
    const token = await tokenResolver(id, { ...options, manager });
    const stored = store.tokens(id);
    return {
      accessToken: token.accessToken,
      ...(stored?.refreshToken === undefined ? {} : { refreshToken: stored.refreshToken }),
      ...(token.expiresAt === undefined ? {} : { tokenExpiresAt: token.expiresAt }),
      externalAccountId: input.externalAccountId,
      scopes: [...token.scopes],
    };
  };
}
