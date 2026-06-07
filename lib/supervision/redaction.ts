const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;
const TOKEN_RE = /\b(?:Bearer\s+)?(?:sk|pk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{8,}\b/g;

const SECRET_KEYS = new Set([
  "authorization",
  "accessToken",
  "refreshToken",
  "apiKey",
  "secret",
  "password",
  "token",
]);

export function redactSensitiveData<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      output[key] = "[REDACTED_TOKEN]";
      continue;
    }
    output[key] = redactValueByKey(key, item);
  }
  return output;
}

function redactValueByKey(key: string, value: unknown): unknown {
  if (typeof value !== "string") return redactValue(value);
  const lowered = key.toLowerCase();
  if (lowered.includes("email")) return "[REDACTED_EMAIL]";
  if (lowered.includes("phone")) return "[REDACTED_PHONE]";
  if (lowered.includes("card")) return "[REDACTED_CARD]";
  return redactString(value);
}

function redactString(value: string): string {
  return value
    .replace(TOKEN_RE, "[REDACTED_TOKEN]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(CARD_RE, "[REDACTED_CARD]")
    .replace(PHONE_RE, "[REDACTED_PHONE]");
}
