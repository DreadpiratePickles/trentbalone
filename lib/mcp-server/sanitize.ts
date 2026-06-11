const URL_CREDENTIAL_RE = /([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;
const TRENT_KEY_RE = /sk-trent-[a-z0-9._-]+/gi;
const GENERIC_SECRET_RE = /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,}]+/gi;

export function sanitizeMcpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "tool failed");
  const sanitized = raw
    .replace(URL_CREDENTIAL_RE, "$1[redacted]@")
    .replace(TRENT_KEY_RE, "[redacted-key]")
    .replace(GENERIC_SECRET_RE, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
  return sanitized.trim() || "tool failed";
}
