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
 *
 * [P1-D] A profile other than `default` inherits a provider it never connected from the default
 * profile's file, when `connect.inherit_default` is on (the default): one grant per machine. The
 * unit is the provider, never the single key, so one grant's access token is never paired with
 * another's refresh token or expiry. `read` and `list` resolve through it and carry `source`, the
 * path the provider came from; `view` is how the resolver reads an inherited provider's values.
 * `tokens` and `field` stay on this profile's own file, because the flows that call them
 * (`connect`, `refresh`, `remove`) write back to the file they read, and the default profile's file
 * is never written from another profile. That file is parsed without being exported into
 * `process.env`: borrowing one provider must not hand this process every other default secret.
 */
import fs from "node:fs";
import dotenv from "dotenv";
import { ConfigManager } from "../config/ConfigManager.js";
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
  /** [P1-D] The file these names were read from. A path, never a value. */
  readonly source: ConnectionSource;
}

/** [P1-D] Where a provider resolved from: a path and whose file it is. Never a value. */
export interface ConnectionSource {
  readonly path: string;
  readonly profile: string;
  /** True when the provider came from the default profile's file because this profile names none of it. */
  readonly inherited: boolean;
}

/** [P1-D] One provider as it resolves: the metadata, and its values from the same file. Resolver use only. */
export interface ProviderView {
  readonly record: ConnectionRecord;
  /** The stored token set, re-read from `record.source`; undefined when the provider is not connected there. */
  tokens(): StoredTokens | undefined;
  /** One field's value, re-read from `record.source`. */
  field(env: string): string | undefined;
}

export interface ConnectStoreOptions {
  /** Overrides `connect.inherit_default` from the profile's config.yaml. */
  readonly inheritDefault?: boolean;
}

type Secrets = Readonly<Record<string, string | undefined>>;

/** One secrets file as the store reads it. */
interface SecretsFile {
  readonly source: ConnectionSource;
  read(): Secrets;
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
  constructor(
    private readonly manager: ConfigManager,
    private readonly options: ConnectStoreOptions = {},
  ) {}

  /** The file every value is WRITTEN to, for a message that names where the secret went. */
  public path(): string {
    return this.manager.getSecretsPath();
  }

  /** Metadata only, from the file the provider resolves from (`source`). */
  public read(id: ConnectProviderId): ConnectionRecord {
    return this.view(id).record;
  }

  public list(): ConnectionRecord[] {
    return CONNECT_PROVIDERS.map((p) => this.read(p.id));
  }

  /**
   * [P1-D] The provider as it resolves. This profile's own file whenever it names any of the
   * provider's env names, even an incomplete set (a half-finished connect here is this profile's);
   * otherwise, with inheritance on and a profile other than `default`, the default profile's file
   * when the provider is connected there; otherwise this profile's own file. The default profile
   * never consults a fallback, so its file is read once. The view's values re-read the same file.
   */
  public view(id: ConnectProviderId): ProviderView {
    const own = this.ownFile();
    const ownSecrets = own.read();
    let chosen: { file: SecretsFile; secrets: Secrets } = { file: own, secrets: ownSecrets };
    const fallback = providerEnvNames(id).some((env) => filled(ownSecrets[env])) ? undefined : this.defaultFile();
    if (fallback !== undefined) {
      const inherited = fallback.read();
      if (recordFrom(id, inherited, fallback.source).connected) chosen = { file: fallback, secrets: inherited };
    }
    const { file } = chosen;
    return {
      record: recordFrom(id, chosen.secrets, file.source),
      tokens: () => tokensFrom(id, file.read()),
      field: (env) => fieldFrom(id, env, file.read()),
    };
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

  /**
   * The stored token set in THIS profile's own file, or undefined when it holds none. Resolver and
   * flow use only; an inherited provider's tokens are read through `view`.
   */
  public tokens(id: ConnectProviderId): StoredTokens | undefined {
    return tokensFrom(id, this.secrets());
  }

  /** One field's value (an API key, a client secret) in THIS profile's own file. Resolver and flow use only. */
  public field(id: ConnectProviderId, env: string): string | undefined {
    return fieldFrom(id, env, this.secrets());
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

  private ownFile(): SecretsFile {
    return {
      source: { path: this.manager.getSecretsPath(), profile: this.manager.getProfile(), inherited: false },
      read: () => this.secrets(),
    };
  }

  /** The default profile's file, read-only and unexported; undefined for `default` itself or with inheritance off. */
  private defaultFile(): SecretsFile | undefined {
    if (this.manager.getProfile() === DEFAULT_PROFILE) return undefined;
    const inherit = this.options.inheritDefault ?? this.manager.loadConfig().connect.inherit_default;
    if (!inherit) return undefined;
    const file = new ConfigManager({ baseDir: this.manager.getBaseDir(), profile: DEFAULT_PROFILE }).getSecretsPath();
    return {
      source: { path: file, profile: DEFAULT_PROFILE, inherited: true },
      read: () => (fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, "utf8")) : {}),
    };
  }
}

const DEFAULT_PROFILE = "default";

function filled(value: string | undefined): value is string {
  return typeof value === "string" && value !== "";
}

function recordFrom(id: ConnectProviderId, secrets: Secrets, source: ConnectionSource): ConnectionRecord {
  const provider = connectProvider(id);
  const has = (env: string): boolean => filled(secrets[env]);
  const present = providerEnvNames(id).filter(has);
  const missing = provider.fields.filter((f) => f.required && !has(f.env)).map((f) => f.env);
  const appConfigured = provider.kind !== "oauth2" || missing.length === 0;
  const base = { provider: id, name: provider.name, kind: provider.kind, appConfigured, present, missing, source };

  if (provider.oauth === undefined) {
    return { ...base, connected: missing.length === 0, scopes: [], hasRefreshToken: false };
  }
  const t = provider.oauth.tokenEnv;
  const expiresAt = secrets[t.expiresAt];
  return {
    ...base,
    connected: has(t.access),
    scopes: splitScopes(secrets[t.scopes]),
    ...(filled(expiresAt) ? { expiresAt } : {}),
    hasRefreshToken: has(t.refresh),
  };
}

function tokensFrom(id: ConnectProviderId, secrets: Secrets): StoredTokens | undefined {
  const provider = connectProvider(id);
  if (provider.oauth === undefined) return undefined;
  const t = provider.oauth.tokenEnv;
  const accessToken = secrets[t.access];
  if (!filled(accessToken)) return undefined;
  const refreshToken = secrets[t.refresh];
  const expiresAt = secrets[t.expiresAt];
  return {
    accessToken,
    ...(filled(refreshToken) ? { refreshToken } : {}),
    ...(filled(expiresAt) ? { expiresAt } : {}),
    scopes: splitScopes(secrets[t.scopes]),
  };
}

function fieldFrom(id: ConnectProviderId, env: string, secrets: Secrets): string | undefined {
  const provider = connectProvider(id);
  if (!provider.fields.some((f) => f.env === env)) {
    throw new Error(`${provider.name} does not own ${env}`);
  }
  const value = secrets[env];
  return filled(value) ? value : undefined;
}

function splitScopes(value: string | undefined): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  return value.split(/[\s,]+/).filter((s) => s !== "");
}
