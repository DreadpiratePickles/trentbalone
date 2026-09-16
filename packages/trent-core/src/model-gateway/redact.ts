/**
 * T3.2 — prompt-side redaction, applied inside the model gateway before anything reaches a provider.
 *
 * The telemetry redactor (`../telemetry/redact.ts`) protects what leaves the machine as a log or a
 * trace. This module protects what leaves it as a prompt: every message content, the system prompt
 * included, and the tool results that ride back into the conversation as messages. It reuses the
 * telemetry layer's secret detectors so there is still one definition of "what a secret looks
 * like", and adds the PII shapes a prompt commonly carries (email, E.164 phone, IPv4) plus the
 * operator's own `privacy.patterns`.
 *
 * Tokens are numbered per kind within one request — `[REDACTED:email#1]` — and the same value maps
 * to the same token wherever it recurs in that request, so the model can still refer to "the first
 * email" without ever seeing it. Hit counts are reported per kind; the values never are.
 */

import { EXIT, TrentError, redactText as errorLayerRedact } from "../errors/index.js";
import { REDACTED_SECRET, secretDetectors } from "../telemetry/redact.js";
import type { GatewayMessage } from "./types.js";

/** The `privacy` block of `config.yaml`, as the gateway reads it. */
export interface PromptPrivacyConfig {
  readonly redact_prompts: boolean;
  readonly patterns: readonly string[];
}

export interface RedactionHit {
  readonly kind: string;
  readonly count: number;
}

export interface RedactedText {
  readonly text: string;
  readonly hits: RedactionHit[];
}

export interface RedactedMessages {
  readonly messages: GatewayMessage[];
  readonly hits: RedactionHit[];
}

export interface PromptRedactor {
  readonly enabled: boolean;
  /** One text, its own numbering context. */
  redactText(text: string): RedactedText;
  /** One request: every message shares a numbering context, so a repeated value keeps its token. */
  redactMessages(messages: readonly GatewayMessage[]): RedactedMessages;
}

/** Env bridge, written by the headless runtime from config; an operator's explicit value wins. */
export const PRIVACY_ENV = {
  redactPrompts: "TRENT_PRIVACY_REDACT_PROMPTS",
  patterns: "TRENT_PRIVACY_PATTERNS",
} as const;

/** The gateway's placeholder shape. Distinct from the telemetry layer's so a reader knows which pass ran. */
export function redactionToken(kind: string, index: number): string {
  return `[REDACTED:${kind}#${index}]`;
}

/** Telemetry rule names that read better as a prompt token kind. */
const KIND_BY_RULE: Readonly<Record<string, string>> = {
  "provider-key": "api-key",
  pem: "private-key",
};

interface Detector {
  readonly kind: string;
  readonly pattern: RegExp;
  /** `$n` template around the placeholder; the whole match is replaced when absent. */
  readonly template?: string;
}

const PII_DETECTORS: readonly Detector[] = [
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "ipv4", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  // E.164: a plus sign, then 7 to 15 digits, no separators.
  { kind: "phone", pattern: /(?<![\w.])\+[1-9]\d{6,14}\b/g },
];

function compileUserPatterns(patterns: readonly string[]): Detector[] {
  return patterns.map((source, index) => {
    try {
      return { kind: "custom", pattern: new RegExp(source, "g") };
    } catch (error) {
      throw new TrentError({
        code: EXIT.CONFIG,
        operation: "privacy.patterns",
        message: `privacy.patterns[${index}] is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        target: `privacy.patterns[${index}]`,
        context: { index },
        cause: error,
      });
    }
  });
}

function buildDetectors(patterns: readonly string[]): Detector[] {
  const secrets: Detector[] = secretDetectors().map((rule) => ({
    kind: KIND_BY_RULE[rule.name] ?? rule.name,
    pattern: rule.pattern,
    template: rule.replacement,
  }));
  return [...secrets, ...PII_DETECTORS, ...compileUserPatterns(patterns)];
}

/** Per-request numbering: one counter per kind, one token per distinct value. */
class NumberingContext {
  readonly #tokens = new Map<string, string>();
  readonly #next = new Map<string, number>();
  readonly #counts = new Map<string, number>();

  tokenFor(kind: string, value: string): string {
    const key = `${kind}\u0000${value}`;
    let token = this.#tokens.get(key);
    if (token === undefined) {
      const index = (this.#next.get(kind) ?? 0) + 1;
      this.#next.set(kind, index);
      token = redactionToken(kind, index);
      this.#tokens.set(key, token);
    }
    this.#counts.set(kind, (this.#counts.get(kind) ?? 0) + 1);
    return token;
  }

  hits(): RedactionHit[] {
    return [...this.#counts.entries()].map(([kind, count]) => ({ kind, count }));
  }
}

function expandTemplate(template: string, groups: readonly string[], token: string): string {
  return template.replace(/\$(\d)/g, (_m, n: string) => groups[Number(n) - 1] ?? "").replace(REDACTED_SECRET, token);
}

function applyDetector(text: string, detector: Detector, ctx: NumberingContext): string {
  return text.replace(detector.pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    // replace() passes (match, ...groups, offset, input[, namedGroups]); the groups end at the
    // numeric offset. An unmatched optional group is undefined and must keep its position.
    const offsetAt = args.findIndex((a, i) => i > 0 && typeof a === "number");
    const groups = args.slice(1, offsetAt).map((g) => (typeof g === "string" ? g : ""));
    const token = ctx.tokenFor(detector.kind, match);
    return detector.template === undefined ? token : expandTemplate(detector.template, groups, token);
  });
}

/**
 * Backstop mirroring the telemetry layer's floor: any remaining whitespace-delimited token the
 * error layer would call a secret is replaced whole. Nothing this module emits can therefore be
 * something the error layer considers a credential.
 */
function applyErrorLayerFloor(text: string, ctx: NumberingContext): string {
  return text.replace(/\S+/g, (token) => (errorLayerRedact(token) === token ? token : ctx.tokenFor("secret", token)));
}

function redactWith(detectors: readonly Detector[], text: string, ctx: NumberingContext): string {
  let out = text;
  for (const detector of detectors) out = applyDetector(out, detector, ctx);
  return applyErrorLayerFloor(out, ctx);
}

/**
 * Build the redactor once per gateway. Compiles `patterns` eagerly so a bad expression fails at
 * config load (exit code 3, with the pattern's index) instead of on the first prompt.
 */
export function createPromptRedactor(options: { enabled: boolean; patterns: readonly string[] }): PromptRedactor {
  const detectors = buildDetectors(options.patterns);
  if (!options.enabled) {
    return {
      enabled: false,
      redactText: (text) => ({ text, hits: [] }),
      redactMessages: (messages) => ({ messages: [...messages], hits: [] }),
    };
  }
  return {
    enabled: true,
    redactText(text) {
      const ctx = new NumberingContext();
      return { text: redactWith(detectors, text, ctx), hits: ctx.hits() };
    },
    redactMessages(messages) {
      const ctx = new NumberingContext();
      const out = messages.map((message) => ({ ...message, content: redactWith(detectors, message.content, ctx) }));
      return { messages: out, hits: ctx.hits() };
    },
  };
}

/** The privacy block as the env bridge carries it. Absent or malformed means off, never a throw. */
export function privacyFromEnv(env: NodeJS.ProcessEnv = process.env): PromptPrivacyConfig {
  const flag = (env[PRIVACY_ENV.redactPrompts] ?? "").trim().toLowerCase();
  const redact_prompts = flag === "1" || flag === "true";
  let patterns: string[] = [];
  const raw = env[PRIVACY_ENV.patterns];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) patterns = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      patterns = [];
    }
  }
  return { redact_prompts, patterns };
}

/**
 * Config -> env, the way `orchestrator/model-env.ts` bridges the model block: the orchestrator
 * builds its gateway with no arguments, so the privacy block travels through the env the gateway
 * reads. Only fills variables the operator left unset. Returns the names written, never values.
 */
export function applyPrivacyEnv(privacy: PromptPrivacyConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  if (privacy === undefined) return [];
  const written: string[] = [];
  if (!env[PRIVACY_ENV.redactPrompts]) {
    env[PRIVACY_ENV.redactPrompts] = privacy.redact_prompts ? "1" : "0";
    written.push(PRIVACY_ENV.redactPrompts);
  }
  if (!env[PRIVACY_ENV.patterns] && privacy.patterns.length > 0) {
    env[PRIVACY_ENV.patterns] = JSON.stringify(privacy.patterns);
    written.push(PRIVACY_ENV.patterns);
  }
  return written;
}
