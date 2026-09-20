/**
 * The token store behind `trent connect`: the profile secrets file, and nothing else.
 *
 * Every value goes through `ConfigManager.saveSecrets`, so it lands in `<profile>/.env` at mode
 * 0600 by an atomic write, the file the hardline list already refuses to let a tool touch
 * (`governance/hardline.ts`). Token metadata (expiry, granted scopes) sits in the same file under
 * its own names so a refresh writes the new token and its expiry in one atomic step and a second
 * process reading the file never sees one without the other.
 *
 * Two read surfaces, on purpose: `read` and `list` return names and metadata for the CLI, the
 * doctor and the security audit, and can never carry a value; `tokens` and `field` return values
 * and exist for the resolver, which hands them to an adapter and to no one else.
 */
import type { ConfigManager } from "../config/ConfigManager.js";
import {
  connectProvider,
  providerEnvNames,
  CONNECT_PROVIDERS,
  type ConnectAuthKind,
  type ConnectProviderId,
} from "./providers.js";

/** What `trent connect list` shows. Names and metadata; no field of this type is a value. */
export interface ConnectionRecord {
  readonly provider: ConnectProviderId;
  readonly name: string;
  readonly kind: ConnectAuthKind;
  /** Every value the provider needs is present (oauth2: an access token is stored). */
  readonly connected: boolean;
  /** oauth2 only: the client id the user registered is present. Always true otherwise. */
  readonly appConfigured: boolean;
  readonly scopes: readonly string[];
  readonly expiresAt?: string;
  readonly hasRefreshToken: boolean;
  /** Env names present in the secrets file, in registry order. */
  readonly present: readonly string[];
  /** Required env names absent from the secrets file. */
  readonly missing: readonly string[];
}

/** The values an oauth2 provider holds; returned only to the resolver and the refresh path. */
export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
}

export interface TokenWrite {
  readonly accessToken: string;
  /** Absent when the provider returned none; the stored refresh token is then kept. */
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
}

/** Scopes are stored on one line; a space separates them and no provider scope contains one. */
const SCOPE_SEPARATOR = " ";

export class ConnectStore {
  constructor(private readonly manager: ConfigManager) {}

  /** The file every value lives in, for a message that names where the secret went. */
  public path(): string {
    return this.manager.getSecretsPath();
  }

  public read(id: ConnectProviderId): ConnectionRecord {
    const provider = connectProvider(id);
    const secrets = this.secrets();
    const has = (env: string): boolean => {
      const value = secrets[env];
      return typeof value === "string" && value !== "";
    };
    const present = providerEnvNames(id).filter(has);
    const missing = provider.fields.filter((f) => f.required && !has(f.env)).map((f) => f.env);
    const appConfigured = provider.kind !== "oauth2" || missing.length === 0;

    if (provider.oauth === undefined) {
      return {
        provider: id,
        name: provider.name,
        kind: provider.kind,
        connected: missing.length === 0,
        appConfigured,
        scopes: [],
        hasRefreshToken: false,
        present,
        missing,
      };
    }

    const t = provider.oauth.tokenEnv;
    const expiresAt = secrets[t.expiresAt];
    return {
      provider: id,
      name: provider.name,
      kind: provider.kind,
      connected: has(t.access),
      appConfigured,
      scopes: splitScopes(secrets[t.scopes]),
      ...(typeof expiresAt === "string" && expiresAt !== "" ? { expiresAt } : {}),
      hasRefreshToken: has(t.refresh),
      present,
      missing,
    };
  }

  public list(): ConnectionRecord[] {
    return CONNECT_PROVIDERS.map((p) => this.read(p.id));
  }

  /**
   * Write field values (an API key, a SID and token, an OAuth client id and secret). A name the
   * provider does not own is refused so a typo cannot park a credential under a stray key, and
   * a blank value is refused rather than written as an empty line.
   */
  public writeFields(id: ConnectProviderId, values: Readonly<Record<string, string>>): void {
    const provider = connectProvider(id);
    const owned = new Set(provider.fields.map((f) => f.env));
    const write: Record<string, string> = {};
    for (const [env, raw] of Object.entries(values)) {
      if (!owned.has(env)) {
        throw new Error(`${provider.name} does not own ${env}; its fields are ${[...owned].join(", ")}`);
      }
      const value = raw.trim();
      if (value === "") throw new Error(`${env} is empty`);
      write[env] = value;
    }
    if (Object.keys(write).length === 0) return;
    this.manager.saveSecrets(write);
  }

  /** Store an oauth2 token set in one atomic write. Keeps the old refresh token when none arrives. */
  public writeTokens(id: ConnectProviderId, tokens: TokenWrite): void {
    const provider = connectProvider(id);
    if (provider.oauth === undefined) throw new Error(`${provider.name} is not an oauth2 provider`);
    const accessToken = tokens.accessToken.trim();
    if (accessToken === "") throw new Error(`${provider.oauth.tokenEnv.access} is empty`);
    const t = provider.oauth.tokenEnv;
    const previous = this.secrets()[t.refresh];
    const refresh = tokens.refreshToken?.trim() || (typeof previous === "string" ? previous : "");
    this.manager.saveSecrets({
      [t.access]: accessToken,
      [t.refresh]: refresh,
      [t.expiresAt]: tokens.expiresAt ?? "",
      [t.scopes]: tokens.scopes.join(SCOPE_SEPARATOR),
    });
  }

  /** The stored token set, or undefined when the provider is not connected. Resolver use only. */
  public tokens(id: ConnectProviderId): StoredTokens | undefined {
    const provider = connectProvider(id);
    if (provider.oauth === undefined) return undefined;
    const t = provider.oauth.tokenEnv;
    const secrets = this.secrets();
    const accessToken = secrets[t.access];
    if (typeof accessToken !== "string" || accessToken === "") return undefined;
    const refreshToken = secrets[t.refresh];
    const expiresAt = secrets[t.expiresAt];
    return {
      accessToken,
      ...(typeof refreshToken === "string" && refreshToken !== "" ? { refreshToken } : {}),
      ...(typeof expiresAt === "string" && expiresAt !== "" ? { expiresAt } : {}),
      scopes: splitScopes(secrets[t.scopes]),
    };
  }

  /** One field's value (an API key, a client secret). Resolver and flow use only. */
  public field(id: ConnectProviderId, env: string): string | undefined {
    const provider = connectProvider(id);
    if (!provider.fields.some((f) => f.env === env)) {
      throw new Error(`${provider.name} does not own ${env}`);
    }
    const value = this.secrets()[env];
    return typeof value === "string" && value !== "" ? value : undefined;
  }

  /**
   * Drop the connection. For an oauth2 provider that is the four token names, and the client id
   * and secret the user registered stay so a reconnect does not ask for them again; for the
   * others it is the fields themselves. Returns the names removed.
   */
  public remove(id: ConnectProviderId): string[] {
    const provider = connectProvider(id);
    const names =
      provider.oauth === undefined
        ? provider.fields.map((f) => f.env)
        : [provider.oauth.tokenEnv.access, provider.oauth.tokenEnv.refresh, provider.oauth.tokenEnv.expiresAt, provider.oauth.tokenEnv.scopes];
    const secrets = this.secrets();
    const removed = names.filter((env) => typeof secrets[env] === "string" && secrets[env] !== "");
    if (removed.length === 0) return [];
    // An empty value is how `saveSecrets` deletes a key; the env export it performs never
    // removes one, so the process environment is cleared here.
    this.manager.saveSecrets(Object.fromEntries(removed.map((env) => [env, ""])));
    for (const env of removed) delete process.env[env];
    return removed;
  }

  /** Always the file, never the cache: a refresh in another process must be visible here. */
  private secrets(): Record<string, string | undefined> {
    return this.manager.loadSecrets({ force: true }) as Record<string, string | undefined>;
  }
}

function splitScopes(value: string | undefined): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(/[\s,]+/).filter((s) => s !== "");
}
