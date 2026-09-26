/**
 * [C16] Reading Hermes's `--format stream-json` (hermes_cli/stream_json.py): `system/init`, `text` deltas,
 * `tool_use`, `tool_result`, one terminal `result` with the token counts. The first output is the first
 * `text` or `tool_use` line on the bench's clock; a line that is not JSON is counted, never fatal.
 */
import { describe, expect, it } from "vitest";
import { createHermesStreamReader } from "./hermes-stream.js";

describe("[C16] the Hermes stream-json reader", () => {
  it("takes the first output from the first text or tool_use line, and the tokens from the result", () => {
    let clock = 1_000;
    const reader = createHermesStreamReader(() => clock);
    reader.push(JSON.stringify({ type: "system", subtype: "init", model: "gemini-3.5-flash-lite", session_id: "s1", timestamp: 1 }));
    clock = 1_250;
    reader.push("not json at all");
    reader.push(JSON.stringify({ type: "tool_use", name: "mcp__trent__square_booking_create", input: { customer: "CUST_JANE" } }));
    clock = 1_400;
    reader.push(JSON.stringify({ type: "tool_result", name: "mcp__trent__square_booking_create", output: "Square booking BK_1 is ACCEPTED", is_error: false }));
    reader.push(JSON.stringify({ type: "text", text: "Booked " }));
    reader.push(JSON.stringify({ type: "text", text: "Jane." }));
    reader.push(JSON.stringify({ type: "result", exit_code: 0, text: "Booked Jane.", tokens: { input: 4000, output: 200, total: 4200, cache_read: 1000, cache_write: 0 }, duration_ms: 900 }));
    expect(reader.summary()).toEqual({
      model: "gemini-3.5-flash-lite",
      firstOutputAt: 1_250,
      toolUses: ["mcp__trent__square_booking_create"],
      toolErrors: 0,
      text: "Booked Jane.",
      malformed: 1,
      result: { exitCode: 0, text: "Booked Jane.", tokens: { input: 4000, output: 200, cachedInput: 1000 }, durationMs: 900 },
    });
  });

  it("has no result and no first output when Hermes printed only its init line", () => {
    const reader = createHermesStreamReader(() => 5);
    reader.push(JSON.stringify({ type: "system", subtype: "init", model: "m" }));
    reader.push("");
    expect(reader.summary()).toMatchObject({ firstOutputAt: undefined, result: undefined, malformed: 0, toolUses: [] });
  });

  it("keeps a failed result's error and never counts more cached tokens than input tokens", () => {
    const reader = createHermesStreamReader(() => 5);
    reader.push(JSON.stringify({ type: "result", exit_code: 1, text: "", error: "provider 429", tokens: { input: 10, output: 0, cache_read: 50 } }));
    expect(reader.summary().result).toEqual({ exitCode: 1, text: "", error: "provider 429", tokens: { input: 10, output: 0, cachedInput: 10 }, durationMs: 0 });
  });
});
