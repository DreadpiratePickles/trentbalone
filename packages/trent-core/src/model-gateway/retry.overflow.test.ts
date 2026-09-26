/**
 * [C12] A context-length 400 is its own class, `context_overflow`: never retried blindly (the same request
 * earns the same refusal), and told apart from every other 400 so a caller that CAN shrink the request
 * (solo's one compaction, `solo/overflow.ts`) knows to.
 *
 * Each provider's wording is copied from a fixture that already exists, never written from memory:
 *   - OpenAI:     Hermes `tests/agent/test_error_classifier.py:998`
 *                 ("This model's maximum context length is 128000 tokens. Please reduce the length of the messages.")
 *   - OpenRouter: Hermes `tests/agent/test_output_cap_parsing.py:12` ("This endpoint's maximum context length is 200000 tokens. ")
 *   - vLLM:       Hermes `tests/agent/test_output_cap_parsing.py:222` ("Requested token count exceeds the model's maximum context length of 131072 tokens.")
 *   - Anthropic:  Hermes `tests/agent/test_413_compression.py:1504` ("prompt is too long: 233153 tokens > 200000 maximum")
 *   - Google:     Hermes `tests/agent/test_model_metadata.py:1699`, "Google Gemini/Gemma overflow phrasing (#57275)"
 *                 ("Unable to submit request because the input token count is 32825 but model only supports up to 32768. ...")
 *   - Ollama:     this repo, `fleet-memory/embedder-local.ts:9-11` (probed 2026-09-26) and `embedder-local.test.ts:162`
 *                 ("the input length exceeds the context length")
 *   - llama.cpp:  Hermes `tests/agent/test_413_compression.py:1030` ("request (70000 tokens) exceeds the available context size (65536 tokens)")
 * The negative cases: an ordinary 400, and a local server's MEMORY ceiling whose tail says "Reduce context size."
 * (Hermes `tests/agent/test_error_classifier.py:810-816`): compaction cannot lower a prefill peak.
 */
import { describe, expect, it } from "vitest";
import { ProviderHttpError, classifyProviderError } from "./retry.js";

const http = (provider: string, body: string, status = 400): ProviderHttpError => new ProviderHttpError({ provider, status, statusText: "Bad Request", body });

const OVERFLOWS: ReadonlyArray<readonly [string, ProviderHttpError]> = [
  ["openai", http("openai", JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.", type: "invalid_request_error", code: "context_length_exceeded" } }))],
  ["openrouter", http("openrouter", JSON.stringify({ error: { message: "This endpoint's maximum context length is 200000 tokens. However, you requested about 230000 tokens.", code: 400 } }))],
  ["vllm", http("openai", JSON.stringify({ message: "Requested token count exceeds the model's maximum context length of 131072 tokens. You requested a total of 140000 tokens." }))],
  ["anthropic", http("anthropic", JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 233153 tokens > 200000 maximum" } }))],
  ["google", http("google", JSON.stringify([{ error: { code: 400, message: "Unable to submit request because the input token count is 32825 but model only supports up to 32768. Reduce the input token count and try again.", status: "INVALID_ARGUMENT" } }]))],
  ["ollama", http("ollama", JSON.stringify({ error: "the input length exceeds the context length" }))],
  ["llama.cpp", http("llamacpp", JSON.stringify({ error: { code: 400, message: "request (70000 tokens) exceeds the available context size (65536 tokens)", type: "exceed_context_size_error" } }))],
];

describe("[C12] classifyProviderError: context_overflow", () => {
  it.each(OVERFLOWS)("classes %s's context-length 400 as context_overflow, not retried", (_provider, error) => {
    expect(classifyProviderError(error)).toEqual({ errorClass: "context_overflow", retryable: false, status: 400 });
  });

  it("reads an SDK-shaped error too: the status, and OpenAI's own code when the message was cut", () => {
    const sdk = Object.assign(new Error("400 status code (no body)"), { status: 400, code: "context_length_exceeded" });
    expect(classifyProviderError(sdk)).toMatchObject({ errorClass: "context_overflow", retryable: false, status: 400 });
    const message = Object.assign(new Error("400 This model's maximum context length is 8192 tokens. However, you requested 9000 tokens."), { status: 400 });
    expect(classifyProviderError(message)).toMatchObject({ errorClass: "context_overflow", retryable: false });
  });

  it("leaves every other refusal where it was: an ordinary 400, a memory ceiling, a 401, a 5xx", () => {
    expect(classifyProviderError(http("openai", JSON.stringify({ error: { message: "Invalid schema for function 'read_file'", type: "invalid_request_error" } })))).toEqual({ errorClass: "validation", retryable: false, status: 400 });
    const ceiling = "Prefill memory guard: predicted peak would require 81.2 GB; safety cap is 77.76 GB (90% of metal_cap ceiling 86.40 GB). Reduce context size.";
    expect(classifyProviderError(http("lmstudio", ceiling))).toMatchObject({ errorClass: "validation", retryable: false });
    expect(classifyProviderError(http("openai", "maximum context length", 401))).toMatchObject({ errorClass: "auth", retryable: false });
    expect(classifyProviderError(http("openai", "maximum context length", 503))).toMatchObject({ errorClass: "dependency", retryable: true });
  });
});
