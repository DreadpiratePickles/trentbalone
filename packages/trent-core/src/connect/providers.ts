/**
 * The provider registry behind `trent connect <provider>`: the seven accounts the business,
 * media and social toolsets execute against, described as data.
 *
 * Every value a provider needs lives in the profile secrets file (`<profile>/.env`, mode 0600,
 * on the hardline list) under the env names declared here; `config/secrets-policy.ts` imports
 * `CONNECT_ENV_NAMES` so `trent config get <NAME>` answers `[set]` and `trent config set` routes
 * the name to that file and never to `config.yaml`. This module is a leaf on purpose: it imports
 * nothing, so the config layer can depend on it without a cycle.
 *
 * Sources for the auth shapes: `01_discovery/output/market-agents-research-2026-09-19.md`
 * (sections 1.1 and 2.1) and, for the Meta and Google endpoints, the app's own
 * `apps/web/lib/platform-oauth.ts`. The app registration (developer console, redirect URI,
 * scopes) is the user's: Trent ships no client id of its own.
 */

export type ConnectProviderId = "stripe" | "google" | "square" | "twilio" | "buffer" | "meta" | "bluesky";

export type ConnectAuthKind = "api_key" | "oauth2" | "basic";

/** One value the user supplies. `secret` values are prompted hidden and never echoed. */
export interface ConnectField {
  readonly env: string;
  readonly label: string;
  readonly secret: boolean;
  /** False for the one value a PKCE client may omit (Square's application secret). */
  readonly required: boolean;
}

export interface OAuthEndpoints {
  readonly authorization: string;
  readonly token: string;
}

/** Where the four token values of an oauth2 provider live in the secrets file. */
export interface OAuthTokenEnv {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAt: string;
  readonly scopes: string;
}

export interface OAuthSpec {
  readonly endpoints: OAuthEndpoints;
  readonly tokenEnv: OAuthTokenEnv;
  /** Proof Key for Code Exchange (RFC 7636), when the provider honours it. */
  readonly pkce: boolean;
  /** Host in the loopback redirect URI: what the provider's console accepts for plain http. */
  readonly redirectHost: "127.0.0.1" | "localhost";
  /** Body encoding of the token endpoint. Square documents a JSON body; the rest take a form. */
  readonly tokenRequest: "form" | "json";
  /** How a token is renewed: a refresh grant, or Meta's long-lived exchange of the token itself. */
  readonly refresh: "refresh_token" | "exchange_long_lived";
  /** Separator in the `scope` parameter. Meta reads commas; RFC 6749 says spaces. */
  readonly scopeSeparator: " " | ",";
  readonly extraAuthorizationParams: Readonly<Record<string, string>>;
}

/** What `trent doctor` would say about the provider, and how to fix it. */
export interface ConnectDoctorSpec {
  readonly name: string;
  readonly fixHint: string;
}

/** The registration the user makes in the provider's console before connecting. */
export interface ConnectRegistration {
  readonly owner: "user";
  readonly console: string;
  /** The exact redirect URI to register (oauth2 only); `<port>` is the `--port` the user picks. */
  readonly redirectUri?: string;
  readonly notes: readonly string[];
}

export interface ConnectProvider {
  readonly id: ConnectProviderId;
  readonly name: string;
  readonly kind: ConnectAuthKind;
  readonly fields: readonly ConnectField[];
  readonly scopes: readonly string[];
  readonly oauth?: OAuthSpec;
  readonly doctor: ConnectDoctorSpec;
  readonly registration: ConnectRegistration;
}

export const LOOPBACK_CALLBACK_PATH = "/callback";

function tokenEnv(prefix: string): OAuthTokenEnv {
  return {
    access: `${prefix}_ACCESS_TOKEN`,
    refresh: `${prefix}_REFRESH_TOKEN`,
    expiresAt: `${prefix}_TOKEN_EXPIRES_AT`,
    scopes: `${prefix}_TOKEN_SCOPES`,
  };
}

function doctor(id: ConnectProviderId, name: string): ConnectDoctorSpec {
  return { name, fixHint: `trent connect ${id}` };
}

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";

export const CONNECT_PROVIDERS: readonly ConnectProvider[] = [
  {
    id: "stripe",
    name: "Stripe",
    kind: "api_key",
    fields: [{ env: "STRIPE_SECRET_KEY", label: "Stripe secret key (sk_live_ or sk_test_)", secret: true, required: true }],
    scopes: [],
    doctor: doctor("stripe", "Stripe secret key"),
    registration: {
      owner: "user",
      console: "https://dashboard.stripe.com/apikeys",
      notes: ["A restricted key with Invoices, Quotes, Payment Links and Customers write access is enough."],
    },
  },
  {
    id: "google",
    name: "Google",
    kind: "oauth2",
    fields: [
      { env: "GOOGLE_CLIENT_ID", label: "Google OAuth client id", secret: false, required: true },
      { env: "GOOGLE_CLIENT_SECRET", label: "Google OAuth client secret", secret: true, required: true },
    ],
    scopes: [`${GOOGLE_SCOPE}calendar`, `${GOOGLE_SCOPE}business.manage`],
    oauth: {
      endpoints: {
        authorization: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
      },
      tokenEnv: tokenEnv("GOOGLE"),
      pkce: true,
      redirectHost: "127.0.0.1",
      tokenRequest: "form",
      refresh: "refresh_token",
      scopeSeparator: " ",
      extraAuthorizationParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
    doctor: doctor("google", "Google Calendar and Business Profile token"),
    registration: {
      owner: "user",
      console: "https://console.cloud.google.com/apis/credentials",
      redirectUri: `http://127.0.0.1:<port>${LOOPBACK_CALLBACK_PATH}`,
      notes: [
        "Create a Desktop app OAuth client; the loopback redirect needs no registered port.",
        "Enable the Google Calendar API; the Business Profile API needs its own access application.",
      ],
    },
  },
  {
    id: "square",
    name: "Square",
    kind: "oauth2",
    fields: [
      { env: "SQUARE_APPLICATION_ID", label: "Square application id", secret: false, required: true },
      { env: "SQUARE_APPLICATION_SECRET", label: "Square application secret (optional with PKCE)", secret: true, required: false },
    ],
    scopes: [
      "APPOINTMENTS_READ",
      "APPOINTMENTS_WRITE",
      "APPOINTMENTS_ALL_READ",
      "APPOINTMENTS_ALL_WRITE",
      "APPOINTMENTS_BUSINESS_SETTINGS_READ",
      "INVOICES_READ",
      "INVOICES_WRITE",
      "ORDERS_READ",
      "ORDERS_WRITE",
      "CUSTOMERS_READ",
      "CUSTOMERS_WRITE",
      "PAYMENTS_WRITE",
      "MERCHANT_PROFILE_READ",
    ],
    oauth: {
      endpoints: {
        authorization: "https://connect.squareup.com/oauth2/authorize",
        token: "https://connect.squareup.com/oauth2/token",
      },
      tokenEnv: tokenEnv("SQUARE"),
      pkce: true,
      redirectHost: "localhost",
      tokenRequest: "json",
      refresh: "refresh_token",
      scopeSeparator: " ",
      extraAuthorizationParams: { session: "false" },
    },
    doctor: doctor("square", "Square bookings and invoices token"),
    registration: {
      owner: "user",
      console: "https://developer.squareup.com/apps",
      redirectUri: `http://localhost:<port>${LOOPBACK_CALLBACK_PATH}`,
      notes: ["Square matches the redirect URL exactly, so pick a port and pass it as --port every time."],
    },
  },
  {
    id: "twilio",
    name: "Twilio",
    kind: "basic",
    fields: [
      { env: "TWILIO_ACCOUNT_SID", label: "Twilio Account SID", secret: false, required: true },
      { env: "TWILIO_AUTH_TOKEN", label: "Twilio auth token", secret: true, required: true },
    ],
    scopes: [],
    doctor: doctor("twilio", "Twilio account SID and auth token"),
    registration: {
      owner: "user",
      console: "https://console.twilio.com/",
      notes: ["US SMS needs an approved A2P 10DLC brand and campaign before the first message sends."],
    },
  },
  {
    id: "buffer",
    name: "Buffer",
    kind: "api_key",
    fields: [{ env: "BUFFER_ACCESS_TOKEN", label: "Buffer access token", secret: true, required: true }],
    scopes: [],
    doctor: doctor("buffer", "Buffer access token"),
    registration: {
      owner: "user",
      console: "https://publish.buffer.com/settings/api",
      notes: ["Connect each social channel inside Buffer first; the token only reaches channels Buffer already holds."],
    },
  },
  {
    id: "meta",
    name: "Meta",
    kind: "oauth2",
    fields: [
      { env: "META_CLIENT_ID", label: "Meta app id", secret: false, required: true },
      { env: "META_CLIENT_SECRET", label: "Meta app secret", secret: true, required: true },
    ],
    scopes: [
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_manage_engagement",
      "pages_manage_metadata",
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_comments",
      "instagram_manage_insights",
      "business_management",
    ],
    oauth: {
      endpoints: {
        authorization: "https://www.facebook.com/v20.0/dialog/oauth",
        token: "https://graph.facebook.com/v20.0/oauth/access_token",
      },
      tokenEnv: tokenEnv("META"),
      pkce: false,
      redirectHost: "localhost",
      tokenRequest: "form",
      refresh: "exchange_long_lived",
      scopeSeparator: ",",
      extraAuthorizationParams: {},
    },
    doctor: doctor("meta", "Meta Pages and Instagram token"),
    registration: {
      owner: "user",
      console: "https://developers.facebook.com/apps",
      redirectUri: `http://localhost:<port>${LOOPBACK_CALLBACK_PATH}`,
      notes: [
        "Accounts without a role on the app need Meta App Review before publishing permissions are granted.",
        "Meta issues no refresh token; trent connect refresh meta exchanges the token for a long-lived one.",
      ],
    },
  },
  {
    id: "bluesky",
    name: "Bluesky",
    kind: "basic",
    fields: [
      { env: "BLUESKY_HANDLE", label: "Bluesky handle", secret: false, required: true },
      { env: "BLUESKY_APP_PASSWORD", label: "Bluesky app password", secret: true, required: true },
    ],
    scopes: [],
    doctor: doctor("bluesky", "Bluesky handle and app password"),
    registration: {
      owner: "user",
      console: "https://bsky.app/settings/app-passwords",
      notes: ["An app password, never the account password; revoke it from the same page."],
    },
  },
];

const BY_ID: ReadonlyMap<string, ConnectProvider> = new Map(CONNECT_PROVIDERS.map((p) => [p.id, p]));

export const CONNECT_PROVIDER_IDS: readonly ConnectProviderId[] = CONNECT_PROVIDERS.map((p) => p.id);

export function isConnectProviderId(value: unknown): value is ConnectProviderId {
  return typeof value === "string" && BY_ID.has(value);
}

/** The registry entry, or a plain Error naming the known ids (the CLI wraps it as a usage error). */
export function connectProvider(id: ConnectProviderId): ConnectProvider {
  const provider = BY_ID.get(id);
  if (provider === undefined) {
    throw new Error(`unknown connect provider "${String(id)}"; known providers: ${CONNECT_PROVIDER_IDS.join(", ")}`);
  }
  return provider;
}

/** Every env name a provider may write: its fields, plus the four token names of an oauth2 one. */
export function providerEnvNames(id: ConnectProviderId): readonly string[] {
  const provider = connectProvider(id);
  const names = provider.fields.map((f) => f.env);
  if (provider.oauth !== undefined) {
    const t = provider.oauth.tokenEnv;
    names.push(t.access, t.refresh, t.expiresAt, t.scopes);
  }
  return names;
}

/** The union over every provider; what `config/secrets-policy.ts` registers as secret names. */
export const CONNECT_ENV_NAMES: readonly string[] = [
  ...new Set(CONNECT_PROVIDERS.flatMap((p) => providerEnvNames(p.id))),
];
