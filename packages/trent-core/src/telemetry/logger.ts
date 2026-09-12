/**
 * Structured logging for every stage of a run.
 *
 * The design decision worth stating: this logger does not redact prompt bodies, it refuses them.
 * A redacting logger is a logger that still writes the transcript to disk and hopes the patterns
 * were complete; the patterns are never complete. So a field named `prompt`, `messages`, `content`,
 * `body`, `completion`, `toolResult` or `tool_payload` is dropped whole — never truncated, never
 * masked, never hashed — and the record notes that it was dropped so the omission is visible.
 *
 * Everything that does get logged still passes through `redactTranscript`, because a "safe" field
 * such as `reason` routinely carries a provider error body with a key in it.
 */

import { redactTranscript } from "./redact.js";
import { TrentError, EXIT } from "../errors/index.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names that carry model or tool payloads. Refused outright.
 * Extending this set is cheap; a leak is not.
 */
export const FORBIDDEN_LOG_FIELDS: ReadonlySet<string> = new Set([
  "prompt",
  "messages",
  "content",
  "body",
  "completion",
  "toolResult",
  "tool_payload",
]);

export type SafeValue = string | number | boolean | null | SafeValue[] | { [k: string]: SafeValue };

export interface LogFields {
  stage?: string;
  taskId?: string;
  [key: string]: unknown;
}

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  runId: string;
  event: string;
  stage?: string;
  taskId?: string;
  droppedFields?: string[];
  [key: string]: unknown;
}

export interface StructuredLoggerOptions {
  runId: string;
  stage?: string;
  taskId?: string;
  level?: LogLevel;
  /** Throw on a forbidden field instead of dropping it. For tests and strict CI runs. */
  strict?: boolean;
  /** Where a serialized record goes. Defaults to stderr, so stdout stays machine-parseable. */
  sink?: (line: string) => void;
  base?: Record<string, unknown>;
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

const MAX_DEPTH = 4;
const MAX_STRING = 512;

/** Coerce an arbitrary value into something safe, finite and bounded. */
function sanitize(value: unknown, depth: number): SafeValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string": {
      const clipped = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
      return redactTranscript(clipped);
    }
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return String(value);
    default:
      break;
  }
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactTranscript(value.message);
  if (typeof value === "object") {
    const out: Record<string, SafeValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_LOG_FIELDS.has(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}

export class StructuredLogger {
  private readonly runId: string;
  private readonly stage?: string;
  private readonly taskId?: string;
  private readonly minLevel: LogLevel;
  private readonly strict: boolean;
  private readonly sink: (line: string) => void;
  private readonly base: Record<string, unknown>;

  constructor(options: StructuredLoggerOptions) {
    this.runId = options.runId;
    if (options.stage !== undefined) this.stage = options.stage;
    if (options.taskId !== undefined) this.taskId = options.taskId;
    this.minLevel = options.level ?? "info";
    this.strict = options.strict ?? false;
    this.sink = options.sink ?? defaultSink;
    this.base = options.base ?? {};
  }

  public child(options: Partial<StructuredLoggerOptions> & LogFields = {}): StructuredLogger {
    const next: StructuredLoggerOptions = {
      runId: options.runId ?? this.runId,
      level: (options.level as LogLevel | undefined) ?? this.minLevel,
      strict: options.strict ?? this.strict,
      sink: this.sink,
      base: { ...this.base },
    };
    const stage = options.stage ?? this.stage;
    const taskId = options.taskId ?? this.taskId;
    if (stage !== undefined) next.stage = stage;
    if (taskId !== undefined) next.taskId = taskId;
    return new StructuredLogger(next);
  }

  public debug(event: string, fields: LogFields = {}): void {
    this.log("debug", event, fields);
  }
  public info(event: string, fields: LogFields = {}): void {
    this.log("info", event, fields);
  }
  public warn(event: string, fields: LogFields = {}): void {
    this.log("warn", event, fields);
  }
  public error(event: string, fields: LogFields = {}): void {
    this.log("error", event, fields);
  }

  public log(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const merged: Record<string, unknown> = { ...this.base, ...fields };
    const dropped: string[] = [];
    const safe: Record<string, SafeValue> = {};

    for (const [key, value] of Object.entries(merged)) {
      if (key === "stage" || key === "taskId") continue;
      if (FORBIDDEN_LOG_FIELDS.has(key)) {
        dropped.push(key);
        continue;
      }
      safe[key] = sanitize(value, 0);
    }

    if (dropped.length > 0 && this.strict) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "log.write",
        message: `refusing to log payload field(s): ${dropped.sort().join(", ")}`,
      });
    }

    const stage = (fields.stage as string | undefined) ?? this.stage;
    const taskId = (fields.taskId as string | undefined) ?? this.taskId;

    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      runId: this.runId,
      event: redactTranscript(event),
    };
    if (stage !== undefined) record.stage = stage;
    if (taskId !== undefined) record.taskId = taskId;
    for (const [k, v] of Object.entries(safe)) record[k] = v;
    if (dropped.length > 0) {
      record.droppedFields = dropped.sort();
      record.droppedFieldsWarning = "payload fields are refused by policy, not redacted";
    }

    this.sink(JSON.stringify(record));
  }
}
