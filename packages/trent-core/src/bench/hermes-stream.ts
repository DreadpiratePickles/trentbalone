/**
 * [C16] Hermes's headless output, read line by line: `hermes chat -q ... --format stream-json` writes one JSON
 * object per stdout line (hermes_cli/stream_json.py): `system/init`, `text` deltas, `tool_use`, `tool_result`,
 * and one terminal `result` with `exit_code`, the final text and `tokens` {input, output, total, cache_read,
 * cache_write}. It carries no cost, so the bench prices the tokens itself (`cost.ts`).
 *
 * Hermes's `tokens.input` is taken to include `cache_read`, as Trent's own rows count a cached prompt token
 * inside `inputTokens`; the cached count is clamped to the input count so a reading the other way never
 * prices a negative uncached share. The first output is the first `text` or `tool_use` line, stamped with the
 * bench's clock when the line arrives, not with Hermes's own `timestamp`.
 */
import type { TokenCounts } from "./types.js";

export interface HermesResult {
  readonly exitCode: number;
  readonly text: string;
  readonly error?: string;
  readonly tokens: TokenCounts;
  readonly durationMs: number;
}

export interface HermesStreamSummary {
  readonly model?: string;
  readonly firstOutputAt: number | undefined;
  /** Tool names as Hermes called them (`mcp__trent__<tool>` for Trent's tools over MCP). */
  readonly toolUses: readonly string[];
  readonly toolErrors: number;
  /** The concatenated `text` deltas. */
  readonly text: string;
  /** Lines that were not a JSON object. */
  readonly malformed: number;
  readonly result: HermesResult | undefined;
}

export interface HermesStreamReader {
  push(line: string): void;
  summary(): HermesStreamSummary;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

function resultOf(line: Record<string, unknown>): HermesResult {
  const tokens = (line.tokens ?? {}) as Record<string, unknown>;
  const input = count(tokens.input);
  return {
    exitCode: typeof line.exit_code === "number" ? line.exit_code : 1,
    text: typeof line.text === "string" ? line.text : "",
    ...(typeof line.error === "string" && line.error !== "" ? { error: line.error } : {}),
    tokens: { input, output: count(tokens.output), cachedInput: Math.min(input, count(tokens.cache_read)) },
    durationMs: count(line.duration_ms),
  };
}

export function createHermesStreamReader(now: () => number): HermesStreamReader {
  let model: string | undefined;
  let firstOutputAt: number | undefined;
  const toolUses: string[] = [];
  let toolErrors = 0;
  let text = "";
  let malformed = 0;
  let result: HermesResult | undefined;
  return {
    push(raw) {
      const line = raw.trim();
      if (line === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        malformed += 1;
        return;
      }
      const event = parsed as Record<string, unknown>;
      if (event.type === "system" && typeof event.model === "string" && event.model !== "") model = event.model;
      if (event.type === "text" || event.type === "tool_use") firstOutputAt ??= now();
      if (event.type === "text" && typeof event.text === "string") text += event.text;
      if (event.type === "tool_use") toolUses.push(typeof event.name === "string" ? event.name : "unknown");
      if (event.type === "tool_result" && event.is_error === true) toolErrors += 1;
      if (event.type === "result") result = resultOf(event);
    },
    summary: () => ({ ...(model === undefined ? {} : { model }), firstOutputAt, toolUses: [...toolUses], toolErrors, text, malformed, result }),
  };
}
