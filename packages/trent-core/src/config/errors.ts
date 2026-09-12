/**
 * Config-layer failures.
 *
 * The intended type is `TrentError` from `../errors/TrentError.js` (exit code 3 =
 * config); that module is owned by another workstream and does not exist yet, so this
 * throws a plain Error carrying the identical shape — `code`, `operation`, `target`,
 * `context` — and the swap is a one-line change in `configError` below.
 */

/** Exit code 3 is the config failure class. */
export const CONFIG_EXIT_CODE = 3;

export interface ConfigErrorFields {
  code: number;
  operation: string;
  target?: string;
  context?: Record<string, unknown>;
}

export type ConfigError = Error & ConfigErrorFields;

/**
 * Build a config failure. The message is `<operation>: <detail>` plus the target so
 * that a caller printing only `err.message` still says what failed and where.
 * Never pass a secret value in `detail` or `context`.
 */
export function configError(
  operation: string,
  detail: string,
  target?: string,
  context?: Record<string, unknown>,
): ConfigError {
  const err = new Error(
    target ? `${operation}: ${detail} (${target})` : `${operation}: ${detail}`,
  ) as ConfigError;
  err.code = CONFIG_EXIT_CODE;
  err.operation = operation;
  if (target !== undefined) err.target = target;
  if (context !== undefined) err.context = context;
  return err;
}
