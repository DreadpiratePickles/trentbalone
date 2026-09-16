/**
 * The single definition of "what a secret looks like" for anything that leaves the machine.
 *
 * Before this module there were two: `errors/TrentError.ts` (whole-string redaction of a context
 * bag, deliberately narrow) and a private regex pair inside `traces/OTelExporter.ts`. Two
 * definitions means a shape fixed in one place still leaks from the other, so the exporter now
 * delegates here and this module keeps the error layer authoritative as a floor:
 *
 *  1. Transcript-shaped patterns below are replaced in place, preserving surrounding text so an
 *     operator can still see `ANTHROPIC_API_KEY=[REDACTED_SECRET]` and know which key to rotate.
 *  2. Every remaining whitespace-delimited token is then run past `redactText` from `../errors/`.
 *     If the error layer would call it a secret, the token is dropped whole. Nothing this module
 *     emits can therefore be something the error layer considers a credential.
 *
 * Transcripts are not error messages: they are long, and blanking the whole string on one match
 * would make an export useless. Hence in-place replacement rather than the error layer's
 * whole-value approach.
 */

import { redactText } from "../errors/index.js";

/** The one placeholder. Kept stable because the OTel exporter's tests assert on it. */
export const REDACTED_SECRET = "[REDACTED_SECRET]";

interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * Order matters. Structured shapes (headers, PEM blocks, URLs) run before the generic long-base64
 * sweep so that the specific rule keeps its useful context and the generic one only mops up.
 */
const RULES: readonly Rule[] = [
  // Whole private key blocks, header and footer included.
  {
    name: "pem",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED_SECRET,
  },
  // Authorization headers of every scheme. The header name survives; the credential does not.
  {
    name: "authorization-header",
    pattern: /\b(authorization|proxy-authorization|x-api-key)(\s*[:=]\s*)([^\r\n,]+)/gi,
    replacement: `$1$2${REDACTED_SECRET}`,
  },
  {
    name: "bearer",
    pattern: /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi,
    replacement: `$1 ${REDACTED_SECRET}`,
  },
  // Provider API keys. Mirrors the error layer's shapes and extends them for transcript use.
  {
    name: "provider-key",
    pattern:
      /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: REDACTED_SECRET,
  },
  // JSON Web Tokens.
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED_SECRET,
  },
  // AWS access key ids.
  {
    name: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED_SECRET,
  },
  // AWS secrets, named explicitly. The value shape alone is too generic to match safely.
  {
    name: "aws-named-secret",
    pattern:
      /\b(aws_secret_access_key|aws_session_token|aws_security_token)(\s*[=:]\s*)("?)([^\s"',]+)/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
  // Passwords embedded in connection strings. Scheme, user and host stay legible.
  {
    name: "connection-string",
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/g,
    replacement: `$1$2:${REDACTED_SECRET}@`,
  },
  // Explicitly named credentials in key=value form.
  {
    name: "named-credential",
    pattern:
      /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|password|passwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("?)([^\s"',]{4,})/gi,
    replacement: `$1$2$3${REDACTED_SECRET}`,
  },
  // Long base64 runs. Last, so anything structured above has already been handled.
  {
    name: "base64-run",
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}/g,
    replacement: REDACTED_SECRET,
  },
];

/**
 * Backstop: apply the error layer's own definition token by token. Guarantees this module can
 * never emit something `redactText` would have caught.
 */
function applyErrorLayerFloor(text: string): string {
  return text.replace(/\S+/g, (token) => (redactText(token) === token ? token : REDACTED_SECRET));
}

/**
 * Redact a conversation transcript, tool output, or any free text that is about to leave the
 * machine. Surrounding prose is preserved; only the credential-shaped runs are replaced.
 */
export function redactTranscript(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return applyErrorLayerFloor(out);
}

/** True when redaction changed anything. Useful for a warn-once on an export path. */
export function containsSecret(text: string): boolean {
  return redactTranscript(text) !== text;
}

/** Rule names, for tests and for a `trent doctor` style report. Never the patterns themselves. */
export function redactionRuleNames(): string[] {
  return RULES.map((r) => r.name);
}

/** One secret detector: the rule name, its pattern and the `$n` template that keeps the context. */
export interface SecretDetector {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * The detectors themselves, in application order, for a redactor that needs to substitute its own
 * placeholder (the model gateway's numbered tokens). Same rules, same order, nothing else.
 */
export function secretDetectors(): readonly SecretDetector[] {
  return RULES;
}
