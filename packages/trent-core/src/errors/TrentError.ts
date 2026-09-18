/**
 * Task 1.2 — the error taxonomy behind `--json` on every command.
 *
 * Every surface (CLI, TUI, Desktop) funnels failure through this module so that a machine reader gets
 * a stable `{"error":{...}}` envelope and a human gets one actionable line. The hard rule is that
 * neither rendering may ever emit a credential: the `context` bag is where callers put "useful
 * debugging detail", and that is precisely where an API key ends up. Redaction is therefore applied on
 * serialization rather than on construction, so no code path can bypass it, and `cause` — which
 * routinely carries request bodies and response headers — is never serialized at all.
 */

/**
 * Process exit codes. 0 ok, 1 run failed, 2 usage, 3 config, 4 auth, 5 provider, 6 budget,
 * 7 awaiting approval, 130 interrupt.
 *
 * `RUN_FAILED` and `APPROVAL_REQUIRED` exist for the one-shot `trent run`, where "the work I asked
 * for did not succeed" and "the work stopped because a human has to decide" are different answers a
 * script must be able to branch on. They are classified outcomes, not the unclassified-throw
 * default below, which stays 2.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130;

export const EXIT: {
  readonly OK: 0;
  readonly RUN_FAILED: 1;
  readonly USAGE: 2;
  readonly CONFIG: 3;
  readonly AUTH: 4;
  readonly PROVIDER: 5;
  readonly BUDGET: 6;
  readonly APPROVAL_REQUIRED: 7;
  readonly INTERRUPT: 130;
} = {
  OK: 0,
  RUN_FAILED: 1,
  USAGE: 2,
  CONFIG: 3,
  AUTH: 4,
  PROVIDER: 5,
  BUDGET: 6,
  APPROVAL_REQUIRED: 7,
  INTERRUPT: 130,
} as const;

/**
 * The exit code used for anything that is not a `TrentError`. An unclassified throw is, from the
 * caller's point of view, indistinguishable from having invoked the tool wrongly, and 1 is reserved by
 * convention for "the process died", so unclassified failures are reported as usage errors (2).
 */
export const DEFAULT_EXIT_CODE: ExitCode = EXIT.USAGE;

/** Operation reported for a throw that did not come from Trent's own error taxonomy. */
export const UNCLASSIFIED_OPERATION = "unclassified";

/** A context key whose name implies its value is a credential. */
const SENSITIVE_KEY = /key|token|secret|password|authorization|credential/i;

/**
 * A value that looks like a credential regardless of the key it sits under. Kept deliberately narrow —
 * a false positive costs a line of debugging detail, a false negative leaks a live key.
 */
const SECRET_SHAPED_VALUE =
  /\b(sk-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{10,})\b/;

const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";

/** Anything that survives `JSON.stringify` unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface TrentErrorOptions {
  code: ExitCode;
  operation: string;
  message: string;
  target?: string;
  context?: Record<string, unknown>;
  cause?: unknown;
}

export interface TrentErrorJson {
  error: {
    code: ExitCode;
    operation: string;
    message: string;
    target?: string;
    context?: Record<string, unknown>;
  };
}

/** Replace a whole string if any part of it looks like a secret; partial masking invites leaks. */
function redactString(value: string): string {
  return SECRET_SHAPED_VALUE.test(value) ? REDACTED : value;
}

function redactValue(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case "string":
      return redactString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    case "function":
    case "symbol":
      return `[${typeof value}]`;
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) return CIRCULAR;
  seen.add(object);

  if (Array.isArray(object)) {
    return object.map((entry) => redactValue(entry, seen));
  }
  if (object instanceof Date) {
    return object.toISOString();
  }
  if (object instanceof Error) {
    // Nested errors carry stacks and response bodies. Keep the shape, drop the payload.
    return redactString(object.message);
  }

  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(object as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, seen);
  }
  return out;
}

/** Redact a context bag: sensitive key names first, then secret-shaped values, recursively. */
export function redactContext(context: Record<string, unknown>): Record<string, JsonValue> {
  const seen = new WeakSet<object>();
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(context)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value, seen);
  }
  return out;
}

/** Redact a free-text string (an error message, a thrown string) before it reaches an output stream. */
export function redactText(text: string): string {
  return redactString(text);
}

function composeMessage(operation: string, message: string, target?: string): string {
  return target === undefined
    ? `${operation}: ${message}`
    : `${operation}: ${message} (${target})`;
}

export class TrentError extends Error {
  readonly code: ExitCode;
  readonly operation: string;
  readonly target?: string;
  readonly context: Record<string, unknown>;

  constructor(opts: TrentErrorOptions) {
    // The composed message is the actionable one: it always names the operation and, when there is
    // one, the concrete target (a file path, a provider, a run id) the operator has to go and fix.
    super(composeMessage(opts.operation, opts.message, opts.target));
    this.name = "TrentError";
    this.code = opts.code;
    this.operation = opts.operation;
    if (opts.target !== undefined) this.target = opts.target;
    this.context = opts.context ?? {};
    // Preserved for debugging, deliberately never serialized.
    if (opts.cause !== undefined) this.cause = opts.cause;
    Error.captureStackTrace?.(this, TrentError);
  }

  toJSON(): TrentErrorJson {
    const error: TrentErrorJson["error"] = {
      code: this.code,
      operation: this.operation,
      message: redactText(this.message),
    };
    if (this.target !== undefined) error.target = redactText(this.target);
    if (Object.keys(this.context).length > 0) error.context = redactContext(this.context);
    return { error };
  }
}

export function isTrentError(err: unknown): err is TrentError {
  return err instanceof TrentError;
}

/** A `TrentError` reports its own code; anything else reports the documented default of 2. */
export function toExitCode(err: unknown): ExitCode {
  return isTrentError(err) ? err.code : DEFAULT_EXIT_CODE;
}

function envelopeFor(err: unknown): TrentErrorJson {
  if (isTrentError(err)) return err.toJSON();

  const message =
    err instanceof Error
      ? redactText(err.message)
      : redactText(typeof err === "string" ? err : String(err));

  return {
    error: {
      code: DEFAULT_EXIT_CODE,
      operation: UNCLASSIFIED_OPERATION,
      message: message.length > 0 ? message : "an unknown error occurred",
    },
  };
}

/** Stable single-line JSON envelope for `--json` on every command. Always `{"error":{...}}`. */
export function renderJsonError(err: unknown): string {
  return JSON.stringify(envelopeFor(err));
}

/** Human-readable output for a TTY. Never prints a stack unless `TRENT_DEBUG` is set. */
export function renderHumanError(err: unknown): string {
  const { error } = envelopeFor(err);
  const lines: string[] = [`error: ${error.message}`];

  if (error.code !== DEFAULT_EXIT_CODE || isTrentError(err)) {
    lines.push(`  exit code: ${error.code}`);
  }
  if (error.context !== undefined) {
    lines.push(`  context: ${JSON.stringify(error.context)}`);
  }

  if (process.env.TRENT_DEBUG !== undefined && process.env.TRENT_DEBUG !== "") {
    if (err instanceof Error && typeof err.stack === "string") {
      lines.push(redactText(err.stack));
    }
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause !== undefined) {
      lines.push(
        `  caused by: ${redactText(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))}`,
      );
    }
  }

  return lines.join("\n");
}
