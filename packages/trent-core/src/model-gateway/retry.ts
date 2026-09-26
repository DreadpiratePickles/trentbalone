/**
 * Bounded retry for one provider attempt (harness audit A.4, shortfall D-6).
 *
 * Before this module the gateway made exactly ONE attempt per provider: a 429 from the first
 * provider in the chain ended the run, because the fallback chain only advances when zero tokens
 * were emitted and a rate limit is not a "no provider configured" error. There was no backoff and
 * `Retry-After` was never read anywhere in the repo.
 *
 * Two rules decide everything here:
 *   1. Only a TRANSIENT failure is retried — 429, 5xx, 408 and the transport-level network codes.
 *      A request the provider understood and refused (400/401/403/404/422) is retried never: the
 *      next attempt is the same request, so it earns the same refusal and just delays the error.
 *   2. The server's own `Retry-After` beats our curve. When it is absent the delay is exponential
 *      with FULL jitter — `random() * min(cap, base * 2^n)` — because a fixed backoff turns a
 *      shared rate limit into a synchronized retry storm across every concurrent run.
 *
 * The numbers live in `DEFAULT_RETRY_POLICY` and nowhere else.
 */

import { redactText } from "../errors/index.js";

/** The rulebook's error taxonomy, as it applies to a provider call. */
export type ErrorClass = "validation" | "auth" | "rate_limit" | "dependency" | "timeout" | "internal";

export interface RetryPolicy {
  /** Total attempts for one provider, INCLUDING the first. 1 means "no retry". */
  readonly attempts: number;
  readonly baseMs: number;
  readonly capMs: number;
}

/** The one place the retry numbers are written. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 3, baseMs: 500, capMs: 8_000 };

export interface ClassifiedFailure {
  readonly errorClass: ErrorClass;
  readonly retryable: boolean;
  readonly status?: number;
  /** Milliseconds the server asked us to wait, when it said so. */
  readonly retryAfterMs?: number;
  /**
   * [L0-2] A cap below the policy's attempts, INCLUDING the first. A timeout gets 2: one retry. The
   * same wait twice is the budget talking, not a blip, and on a local model each wait is minutes.
   */
  readonly maxAttempts?: number;
}

/** [L0-2] A timeout is retried once (G16). */
const TIMEOUT_MAX_ATTEMPTS = 2;

/** Transport failures that mean "try again", not "you asked for the wrong thing". */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

const TIMEOUT_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ETIME",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export interface ProviderHttpErrorOptions {
  readonly provider: string;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: Headers | Record<string, string>;
  /** The response body, truncated and redacted before it becomes part of the message. */
  readonly body?: string;
}

const MAX_BODY_CHARS = 200;

/**
 * A non-2xx from an OpenAI-compatible endpoint. It carries the status and the response headers so
 * the classifier can read `Retry-After` without re-parsing a message, and it redacts the body:
 * a provider's 401 payload routinely quotes the key it just rejected.
 */
export class ProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: Headers | Record<string, string>;

  constructor(options: ProviderHttpErrorOptions) {
    const statusText = options.statusText ?? "";
    const detail = options.body ? `: ${redactText(options.body.slice(0, MAX_BODY_CHARS))}` : "";
    super(`${options.provider} request failed with HTTP ${options.status} ${statusText}${detail}`.trim());
    this.name = "ProviderHttpError";
    this.provider = options.provider;
    this.status = options.status;
    this.statusText = statusText;
    if (options.headers !== undefined) this.headers = options.headers;
  }
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** HTTP status from our own error, an SDK error (`status`), or a wrapped response. */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  return (
    numberField(candidate.status)
    ?? numberField(candidate.statusCode)
    ?? numberField(candidate.response?.status)
  );
}

function headersOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { headers?: unknown; response?: { headers?: unknown } };
  return candidate.headers ?? candidate.response?.headers;
}

/** Reads one header from a `Headers` instance or a plain record, case-insensitively. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => string | null).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return undefined;
}

/** The node/undici error code, including the one undici hides on `cause`. */
function networkCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate.code === "string") return candidate.code;
  if (typeof candidate.cause?.code === "string") return candidate.cause.code;
  return undefined;
}

/**
 * `Retry-After` in either legal form: delta-seconds, or an HTTP date. A date already in the past
 * means "now" (0), not "never". Anything else is not a delay and is ignored.
 */
export function parseRetryAfter(raw: string | undefined | null, nowMs: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined;
  }
  // An HTTP-date always carries a day and month name; `Date.parse` otherwise accepts things like
  // "-3" as a year and would turn a malformed header into a zero-length wait.
  if (!/[A-Za-z]/.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/**
 * [L0-2] openai-node's `APIConnectionTimeoutError` (4.104.0): no status, no code, and no `name` of its
 * own, so it read as `internal` and was never retried (audit G16: "planner call failed: internal
 * (Request timed out.)"). Matched by its class name or its fixed message, without importing the SDK.
 */
function isSdkTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  for (let proto: object | null = Object.getPrototypeOf(error); proto !== null && proto !== Error.prototype; proto = Object.getPrototypeOf(proto)) {
    if ((proto as { constructor?: { name?: string } }).constructor?.name === "APIConnectionTimeoutError") return true;
  }
  return error.message === "Request timed out.";
}

/** Classify a provider failure into the rulebook's taxonomy and say whether it may be retried. */
export function classifyProviderError(error: unknown, nowMs: number = Date.now()): ClassifiedFailure {
  const status = statusOf(error);
  if (status !== undefined && status >= 400) {
    const retryAfterMs = parseRetryAfter(headerValue(headersOf(error), "retry-after"), nowMs);
    const withRetryAfter = retryAfterMs === undefined ? {} : { retryAfterMs };
    if (status === 429) return { errorClass: "rate_limit", retryable: true, status, ...withRetryAfter };
    if (status === 408) return { errorClass: "timeout", retryable: true, status, maxAttempts: TIMEOUT_MAX_ATTEMPTS, ...withRetryAfter };
    if (status >= 500) return { errorClass: "dependency", retryable: true, status, ...withRetryAfter };
    if (status === 401 || status === 403) return { errorClass: "auth", retryable: false, status };
    return { errorClass: "validation", retryable: false, status };
  }

  const code = networkCodeOf(error);
  if (code !== undefined) {
    if (TIMEOUT_CODES.has(code)) return { errorClass: "timeout", retryable: true, maxAttempts: TIMEOUT_MAX_ATTEMPTS };
    if (RETRYABLE_NETWORK_CODES.has(code)) return { errorClass: "dependency", retryable: true };
  }

  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || isSdkTimeout(error)) return { errorClass: "timeout", retryable: true, maxAttempts: TIMEOUT_MAX_ATTEMPTS };

  const message = error instanceof Error ? error.message : "";
  // undici reports every transport failure as this one TypeError.
  if (/fetch failed|network error|socket hang up/i.test(message)) {
    return { errorClass: "dependency", retryable: true };
  }

  return { errorClass: "internal", retryable: false };
}

export interface RetryDelayInput {
  /** 1-based: the attempt that just failed. */
  readonly attempt: number;
  readonly policy: RetryPolicy;
  readonly retryAfterMs?: number;
  readonly random?: () => number;
}

/** Full jitter, capped — unless the server named a delay, which is obeyed exactly (still capped). */
export function retryDelayMs(input: RetryDelayInput): number {
  if (input.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, Math.round(input.retryAfterMs)), input.policy.capMs);
  }
  const exponent = Math.max(0, input.attempt - 1);
  const ceiling = Math.min(input.policy.capMs, input.policy.baseMs * 2 ** exponent);
  const draw = (input.random ?? Math.random)();
  return Math.round(Math.max(0, Math.min(1, draw)) * ceiling);
}

function boundedMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Config -> policy. A nonsense value falls back to the default; 0 attempts means "retries off" (1). */
export function resolveRetryPolicy(input: Partial<RetryPolicy> | undefined): RetryPolicy {
  const rawAttempts = input?.attempts;
  const attempts =
    typeof rawAttempts === "number" && Number.isFinite(rawAttempts) && rawAttempts >= 0
      ? Math.max(1, Math.floor(rawAttempts))
      : DEFAULT_RETRY_POLICY.attempts;
  return {
    attempts,
    baseMs: boundedMs(input?.baseMs, DEFAULT_RETRY_POLICY.baseMs),
    capMs: boundedMs(input?.capMs, DEFAULT_RETRY_POLICY.capMs),
  };
}

/**
 * The real delay. Injected in tests so a backoff is asserted, never waited for.
 *
 * It ends the moment the run is cancelled: a Ctrl+C during an 8-second backoff must return the
 * prompt now, not eight seconds from now, and the caller must not start another attempt after it.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
