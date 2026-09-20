# `trent connect`: provider credentials and the token store

The business, media and social toolsets execute against real accounts: a Stripe invoice, a Google
Calendar booking, a Square appointment, a Twilio text, a Buffer or Meta post. `trent connect` is
how those accounts reach Trent, and the profile secrets file is the only place their credentials
live.

Everything here is implemented in `packages/trent-core/src/connect/` and the `connect` command
group, and proved by `connect/providers.test.ts`, `connect/store.test.ts`,
`connect/oauth-flow.test.ts`, `connect/resolver.test.ts`, `connect/doctor.test.ts` and
`apps/cli/src/commands/__tests__/connect.test.ts`. The OAuth tests run against a local
authorization server (`connect/testing/fake-oauth-server.ts`); no test reaches a provider.

## Where a credential goes, and where it never goes

Every value `trent connect` takes is written to `<profile>/.env` (`~/.trent/.env` for the default
profile) through the same atomic 0600 write `trent config set` uses. That file is already on the
hardline list (`write-to-trent-secrets`, docs/security.md), so no tool call can rewrite it at any
autonomy level, and `trent security audit` checks its mode on every run.

Nothing goes to `config.yaml`, which is 0644 and scanned for credentials by the audit. Nothing is
printed: a connect, a refresh and `trent connect list` report the provider, the auth kind, the
scopes granted, the expiry and the env names written, and never a value. `trent config get
STRIPE_SECRET_KEY` answers `[set]` or `[unset]`, because every name below is registered with the
secrets policy (`config/secrets-policy.ts`, `EXTRA_SECRET_NAMES`).

The app's `encryptJson` is deliberately not reused: without `SECRET_ENCRYPTION_KEY` its key derives
from a public constant (`apps/web/lib/secrets.ts`), and a file the operating system keeps to one
user is the stronger boundary on a workstation.

## The providers

| Provider | Kind | Env names in the secrets file | What the user registers (owner: the user) |
|---|---|---|---|
| `stripe` | api_key | `STRIPE_SECRET_KEY` | A secret or restricted key at https://dashboard.stripe.com/apikeys with Invoices, Quotes, Payment Links and Customers write access |
| `google` | oauth2 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, then `GOOGLE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_TOKEN_EXPIRES_AT`, `GOOGLE_TOKEN_SCOPES` | A Desktop app OAuth client at https://console.cloud.google.com/apis/credentials with the Calendar API enabled; the Business Profile API needs Google's own access application (a verified profile, 60 days old, with a website) |
| `square` | oauth2 | `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET` (optional, PKCE), then `SQUARE_ACCESS_TOKEN`, `SQUARE_REFRESH_TOKEN`, `SQUARE_TOKEN_EXPIRES_AT`, `SQUARE_TOKEN_SCOPES` | An application at https://developer.squareup.com/apps with the redirect URL registered exactly |
| `twilio` | basic | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | An account at https://console.twilio.com/; US SMS needs an approved A2P 10DLC brand and campaign before the first message |
| `buffer` | api_key | `BUFFER_ACCESS_TOKEN` | An access token at https://publish.buffer.com/settings/api; each channel is connected inside Buffer first |
| `meta` | oauth2 | `META_CLIENT_ID`, `META_CLIENT_SECRET`, then `META_ACCESS_TOKEN`, `META_REFRESH_TOKEN` (always empty), `META_TOKEN_EXPIRES_AT`, `META_TOKEN_SCOPES` | An app at https://developers.facebook.com/apps; accounts without a role on the app need Meta App Review before publishing permissions are granted |
| `bluesky` | basic | `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` | An app password at https://bsky.app/settings/app-passwords, never the account password |

The registry (`connect/providers.ts`) is the source of this table: the auth kind, the env names,
the scopes, the token endpoints, the redirect host and the doctor line per provider. Trent ships no
client id of its own; the app registration is the user's in every case.

### Scopes requested

- Google: `https://www.googleapis.com/auth/calendar` and
  `https://www.googleapis.com/auth/business.manage`, with `access_type=offline` and
  `prompt=consent` so a refresh token is issued.
- Square: `APPOINTMENTS_READ`, `APPOINTMENTS_WRITE`, `APPOINTMENTS_ALL_READ`, `APPOINTMENTS_ALL_WRITE`,
  `APPOINTMENTS_BUSINESS_SETTINGS_READ`, `INVOICES_READ`, `INVOICES_WRITE`, `ORDERS_READ`,
  `ORDERS_WRITE`, `CUSTOMERS_READ`, `CUSTOMERS_WRITE`, `PAYMENTS_WRITE`, `MERCHANT_PROFILE_READ`.
- Meta: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`,
  `pages_manage_metadata`, `instagram_basic`, `instagram_content_publish`,
  `instagram_manage_comments`, `instagram_manage_insights`, `business_management`.

What a provider actually granted is what is stored and listed, when the provider reports it
(Google and Meta do; Square does not, so the requested list stands in).

## The commands

```
trent connect <provider>            an API key or a basic pair (hidden prompt), or the OAuth flow
trent connect <provider> --from-env NAME    read the secret from that environment variable
trent connect <provider> --from-env         read every field from its own env name
trent connect twilio --username <sid> --from-env NAME
trent connect google --port 8765    a fixed loopback port, for a console that matches the URI exactly
trent connect google --no-browser   print the authorization URL instead of opening a browser
trent connect list                  provider, kind, scopes, expiry; never a value
trent connect refresh <provider>    renew the access token now
trent connect remove <provider>     drop the tokens (an OAuth app registration stays)
```

`--dry-run` answers with what would happen and exit 0; `--json` is on every subcommand. An API
key or basic pair prompts hidden when a terminal is attached; with no terminal and no `--from-env`,
the command refuses and names the flag rather than waiting on a prompt nobody can answer.

### The OAuth flow

`trent connect google` (or `square`, `meta`):

1. Reads the client id and secret from the secrets file; without them it exits 3 and names the
   env name to `trent config set`.
2. Starts a listener on `127.0.0.1` on a free port (or `--port`), so the redirect URI is
   `http://127.0.0.1:<port>/callback` for Google and `http://localhost:<port>/callback` for
   Square and Meta, whose consoles accept plain http on `localhost` only.
3. Opens the browser at the provider's authorization endpoint with a random `state`, and a PKCE
   `code_challenge` (S256) for Google and Square. Meta's dialog does not honour PKCE, so its
   flow relies on the state and the app secret.
4. Accepts one callback. A callback whose `state` is not the one sent is refused with a 400 and
   the command exits 4 without touching the token endpoint. A provider `error` exits 4 naming the
   error code. Nothing from the query is rendered into the page the browser sees.
5. Exchanges the code at the token endpoint with the same redirect URI and the PKCE verifier
   (a form body; a JSON body for Square, which documents one). A refusal is reported by status
   and error code only; a provider's response body is never repeated, because it can echo the
   code or the secret.
6. Writes the access token, the refresh token, the expiry and the granted scopes in one atomic
   0600 write, and prints the provider name and the scopes.

Google and Square renew with a refresh grant. Meta issues no refresh token; `trent connect
refresh meta` exchanges the current token for a long-lived one (`fb_exchange_token`).

## The resolver the toolsets call

```ts
import { tokenResolver, platformTokenResolver } from "@trent/core/connect/index.js";

const token = await tokenResolver("google");
// { provider, kind, accessToken, expiresAt?, scopes, refreshed, username? }
```

`tokenResolver(provider, options?)` returns a credential usable now. For an oauth2 provider a
token inside five minutes of its expiry, or past it, is refreshed first, under a lock that is a
promise chain within the process and a `mkdir` directory (`<profile>/.connect-<provider>.lock`)
across processes, so three adapters racing in one step and a cron tick racing an interactive run
produce one refresh and all read the token it stored. An expired token with nothing to refresh it
exits 4 naming `trent connect <provider>`. For an api_key provider the result is the key; for a
basic provider it is the secret with `username` set to the identifier.

`platformTokenResolver(options?)` is the same resolver in the exact shape
`apps/web/lib/social/live-platform-adapter.ts` injects as `deps.tokenResolver`
(`{ companyId, platform, externalAccountId } -> SocialCredential | undefined`), typed against that
file. `youtube` resolves through `google`; `instagram`, `facebook` and `threads` through `meta`;
a platform `trent connect` does not hold, or one that is not connected, answers `undefined` so the
adapter raises its own `needs_credentials`.

`connectDoctorLines(store)` gives one `CheckResult`-shaped line per provider (ok, warn on an expired
token with `trent connect refresh <provider>` as the fix, skip when not connected) for a doctor
check to emit.

## What the security audit sees

After a connect, `trent security audit` finds no `secret-in-config-yaml` and its `file-permissions`
section has checked `.env` with no problem against it. The audit's `sessions/` directory finding
that appears after any secret write is a pre-existing behaviour of `ConfigManager.ensureDirs`
(it creates the directory at 0755 while the audit expects 0700), not of this flow.

## Not yet implemented

- No toolset calls the resolver yet: the business, media and social executors that will are
  the next tasks of the upgrade round (`02_plan/output/upgrade-round-design.md`, section 3).
- `trent doctor` does not yet include the connect lines; `connectDoctorLines` is ready for the
  check that will.
- Bluesky's app password is stored, not exchanged for a session: the AT Protocol
  `createSession` call belongs to the social toolset.
- `trent connect` stores no external account id (a Facebook Page id, an Instagram user id); the
  platform resolver passes through the one the adapter asks with.
