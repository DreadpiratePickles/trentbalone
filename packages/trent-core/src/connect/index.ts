/**
 * `trent connect`: the credential flow and token store the business, media and social
 * toolsets execute against real accounts with. Tokens live in the profile secrets file
 * (`<profile>/.env`, 0600, on the hardline list), never in `config.yaml` and never in a log.
 *
 *   providers.ts  the registry: auth kind, env names, scopes, endpoints, the doctor line
 *   store.ts      the token store over `ConfigManager.saveSecrets`
 *   loopback.ts   the RFC 8252 loopback listener with the state check
 *   oauth.ts      PKCE, the authorization URL, the token endpoint requests
 *   flow.ts       connect, refresh, and the api_key and basic writes
 *   resolver.ts   `tokenResolver(provider)` and the adapter-shaped `platformTokenResolver`
 *   lock.ts       the refresh lock (in-process chain plus a directory lock on the profile)
 *   doctor.ts     one `CheckResult`-shaped line per provider
 */
export * from "./providers.js";
export * from "./store.js";
export * from "./loopback.js";
export * from "./oauth.js";
export * from "./flow.js";
export * from "./resolver.js";
export * from "./lock.js";
export * from "./doctor.js";
