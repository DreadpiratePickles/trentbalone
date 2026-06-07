/**
 * Structured logger with PII redaction.
 *
 * Standard log keys (T0.4):
 *   companyId, cycleId, agentId, toolName, traceId
 *
 * PII fields are redacted automatically before any log is emitted.
 * Use logger.child({ companyId, cycleId }) to create request-scoped loggers.
 */

import pino from "pino";

// ── PII redaction paths ────────────────────────────────────────────────────
// pino redacts these paths with "[Redacted]" in all log records.
const REDACT_PATHS = [
  "*.email",
  "*.password",
  "*.token",
  "*.secret",
  "*.apiKey",
  "*.api_key",
  "*.encryptedData",
  "*.creditCard",
  "*.ssn",
  "*.databaseUrl",
  "*.DATABASE_URL",
  "*.GITHUB_TOKEN",
  "*.AUTH_SECRET",
  "*.SECRET_ENCRYPTION_KEY",
  "*.OPENAI_API_KEY",
  "*.ANTHROPIC_API_KEY",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
];

const isDev = process.env.NODE_ENV === "development";
const isTest = process.env.NODE_ENV === "test";

export const logger = pino({
  level: isTest ? "silent" : (process.env.LOG_LEVEL ?? (isDev ? "debug" : "info")),
  redact: {
    paths: REDACT_PATHS,
    censor: "[Redacted]",
  },
  transport: isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } }
    : undefined,
  base: {
    env: process.env.NODE_ENV,
    app: "trent",
  },
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

// ── Context logger factory ─────────────────────────────────────────────────
export type LogContext = {
  companyId?: string;
  cycleId?: string;
  agentId?: string;
  agentRole?: string;
  toolName?: string;
  traceId?: string;
  taskId?: string;
  sessionId?: string;
};

export function contextLogger(ctx: LogContext) {
  return logger.child(ctx);
}

export default logger;
