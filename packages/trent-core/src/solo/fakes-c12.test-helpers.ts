/**
 * [C12] Fakes for the long-session tests: the provider refusal they script. Nothing here calls a model.
 */
import { ProviderHttpError } from "../model-gateway/retry.js";

/** Anthropic's own words (Hermes `tests/agent/test_413_compression.py:1504`), as the gateway throws them. */
export const overflow400 = (): ProviderHttpError =>
  new ProviderHttpError({ provider: "anthropic", status: 400, statusText: "Bad Request", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 233153 tokens > 200000 maximum" } }) });
