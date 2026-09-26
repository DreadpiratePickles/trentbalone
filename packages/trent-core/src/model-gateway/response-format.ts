/**
 * [L1] Constrained output: which route carries a request's `responseFormat`, and in what form.
 *
 * A seat on a 9B local model scored 1/5 on the doctor's tool-call smoke writing its own shape
 * (`"action": "read_file", {...}`) instead of the fleet's (docs/sessions/2026-09-26-harness-landscape.md,
 * L0-4). Every local runtime can constrain decoding to a JSON schema; this is where the gateway asks.
 *
 * ONE WIRE SHAPE, `{type: "json_schema", json_schema: {name, schema}}`, read from each runtime's own
 * parser or docs on 2026-09-26:
 *   - Ollama: `openai/openai.go` (github.com/ollama/ollama, main) `ResponseFormat{Type, JsonSchema{Schema}}`;
 *     `json_schema` becomes the native `format` (the schema), `json_object` becomes `format: "json"`.
 *     The field is listed at https://docs.ollama.com/api/openai-compatibility; structured outputs at
 *     https://docs.ollama.com/capabilities/structured-outputs.
 *   - llama.cpp `llama-server`: `tools/server/server-common.cpp` (ggml-org/llama.cpp, master) reads
 *     `response_format.json_schema.schema` for `json_schema` and `response_format.schema` for
 *     `json_object`; https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md.
 *   - LM Studio: `{"type":"json_schema","json_schema":{"name","strict","schema"}}`,
 *     https://lmstudio.ai/docs/developer/openai-compat/structured-output (GGUF through llama.cpp's
 *     grammar, MLX through Outlines; "not all models are capable ... below 7B").
 *   - vLLM: `{"type":"json_schema","json_schema":{"name","schema"}}`,
 *     https://docs.vllm.ai/en/latest/features/structured_outputs.html.
 * llama.cpp and vLLM have no alias of their own; behind an alias's base URL they follow its row.
 *
 * Hosted routes: OpenAI structured outputs (https://platform.openai.com/docs/guides/structured-outputs)
 * and Google's OpenAI-compatible endpoint (https://ai.google.dev/gemini-api/docs/openai, "Structured
 * output") take the schema. DeepSeek documents JSON mode only (https://api-docs.deepseek.com/guides/json_mode);
 * Groq documents schemas for a list of models and JSON mode for all
 * (https://console.groq.com/docs/structured-outputs), so both get `json_object`, never a schema a model
 * may refuse with a 400. `anthropic`, `mistral` and `openrouter` stream through the app's client, which
 * has no field for it. `mlx_lm.server` has no `response_format` in its source (not an alias; not sent).
 */

import type { GatewayResponseFormat } from "./types.js";

/** What a route accepts: the schema itself, plain JSON mode, or nothing. */
export type ResponseFormatSupport = "json_schema" | "json_object" | "none";

export const RESPONSE_FORMAT_SUPPORT: Readonly<Record<string, ResponseFormatSupport>> = {
  ollama: "json_schema",
  lmstudio: "json_schema",
  openai: "json_schema",
  google: "json_schema",
  deepseek: "json_object",
  groq: "json_object",
  anthropic: "none",
  mistral: "none",
  openrouter: "none",
};

/** The `response_format` to put on the body for `label` (a provider or an alias), or undefined. */
export function responseFormatFor(label: string, format: GatewayResponseFormat | undefined): GatewayResponseFormat | undefined {
  if (format === undefined) return undefined;
  const support = RESPONSE_FORMAT_SUPPORT[label] ?? "none";
  if (support === "none") return undefined;
  if (support === "json_object" || format.type === "json_object") return { type: "json_object" };
  return format;
}

/**
 * The gateway's per-instance decision, logged once per route and outcome: a format downgraded to JSON
 * mode (`model_gateway.response_format_downgraded`) or dropped (`model_gateway.response_format_not_sent`).
 * Names only; the schema itself is never logged.
 */
export function createResponseFormatPolicy(
  log: (event: string, fields: Record<string, unknown>) => void,
): (label: string, format: GatewayResponseFormat | undefined) => GatewayResponseFormat | undefined {
  const said = new Set<string>();
  return (label, format) => {
    const sent = responseFormatFor(label, format);
    if (format === undefined) return sent;
    const event = sent === undefined ? "model_gateway.response_format_not_sent" : sent.type !== format.type ? "model_gateway.response_format_downgraded" : undefined;
    if (event !== undefined && !said.has(`${event}|${label}`)) {
      said.add(`${event}|${label}`);
      log(event, { provider: label, asked: format.type, sent: sent?.type ?? "none" });
    }
    return sent;
  };
}
