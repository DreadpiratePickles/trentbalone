import { CONNECT_ENV_NAMES } from "../connect/providers.js";
import { TrentSecretsSchema } from "./schema.js";

/**
 * Secret routing rules, in order. A key is a secret if and only if one of these says so:
 *
 *   1. It is prefixed `secrets.` — an explicit caller instruction.
 *   2. Otherwise, if its last dot-segment is on NON_SECRET_KEYS it is NOT a secret.
 *      This list wins over everything below it and exists because ordinary config keys
 *      such as `public_key_id` are public identifiers, not credentials.
 *   3. It is on the allowlist of known secret names (the `.env` schema keys plus
 *      EXTRA_SECRET_NAMES).
 *   4. It is environment-variable shaped (`^[A-Z][A-Z0-9_]*$`) AND ends in one of
 *      `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`.
 *
 * The old rule was `key.endsWith("_KEY")` alone, which routed any such config key into
 * `.env`. Rules 2 and 4 together are what stop that.
 */
export const SECRET_NAME_PATTERN = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/;

/** Env-var shape: uppercase, digits and underscores only. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Secret names not (or not yet) declared in TrentSecretsSchema. The `trent connect` names come
 * from the provider registry, so a provider added there is routed to the secrets file the same
 * day: its tokens, and also its identifiers (an account SID, a client id) and token metadata
 * (expiry, granted scopes), because `trent connect list` is where those are read back and
 * `config get` answering `[set]` for the whole family is simpler to reason about than a split.
 */
export const EXTRA_SECRET_NAMES: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "GITHUB_TOKEN",
  ...CONNECT_ENV_NAMES,
];

export const SECRET_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ...Object.keys(TrentSecretsSchema.shape),
  ...EXTRA_SECRET_NAMES,
]);

/**
 * Config keys that look secret-ish but are public values. Compared case-insensitively
 * against the final dot-segment of the key.
 */
export const NON_SECRET_KEYS: ReadonlySet<string> = new Set<string>([
  "public_key",
  "public_key_id",
  "signing_public_key",
  "host_key",
  "key_path",
  "key_id",
  "api_key_id",
  "trigger_key",
  "cache_key",
  "idempotency_key",
]);

export function isSecretKey(key: string): boolean {
  if (key.startsWith("secrets.")) return true;

  const segments = key.split(".");
  const last = segments[segments.length - 1] ?? key;

  if (NON_SECRET_KEYS.has(last.toLowerCase())) return false;
  if (SECRET_ALLOWLIST.has(last)) return true;

  return ENV_NAME_PATTERN.test(last) && SECRET_NAME_PATTERN.test(last);
}

/** Strip the optional `secrets.` prefix to get the raw `.env` variable name. */
export function toSecretName(key: string): string {
  const bare = key.replace(/^secrets\./, "");
  const segments = bare.split(".");
  return segments[segments.length - 1] ?? bare;
}
