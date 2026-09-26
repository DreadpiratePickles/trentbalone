/**
 * [P2-13] Gemini's native embeddings dialect, for the one thing the OpenAI-compatible surface cannot
 * carry: an asymmetric task type per text.
 *
 * Google's `gemini-embedding-001` embeds a question and a passage into different regions of one
 * space when told which is which: RETRIEVAL_QUERY for the question, RETRIEVAL_DOCUMENT for what may
 * answer it (https://ai.google.dev/gemini-api/docs/embeddings, "Task types"). The OpenAI-compatible
 * `/v1beta/openai/embeddings` takes `{model, input}` and nothing else, so a call that names roles
 * goes to `models/<model>:batchEmbedContents` instead, one request per text, with the key in the
 * `x-goog-api-key` header (never the query string, where a proxy log would keep it).
 *
 * The native base is DERIVED from the compatible one, so `GEMINI_BASE_URL` still moves both: the
 * shipped `.../v1beta/openai` becomes `.../v1beta`. A base that does not end in `/openai` is a proxy
 * or mirror that has only promised the compatible dialect; there is no native endpoint to derive,
 * so task types are off for it and the call stays symmetric (`embedder.ts`).
 */

import type { EmbedRole } from "./lexical.js";

/** Google's names for the two roles a retrieval call has. */
export const GEMINI_TASK_TYPES: Readonly<Record<EmbedRole, string>> = {
  query: "RETRIEVAL_QUERY",
  document: "RETRIEVAL_DOCUMENT",
};

/** The native `v1beta` base behind a compatible base URL, or undefined when there is none to derive. */
export function nativeGeminiBase(compatibleBaseUrl: string): string | undefined {
  const trimmed = compatibleBaseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/openai") ? trimmed.slice(0, -"/openai".length) : undefined;
}

/** `models/<model>:batchEmbedContents` under a native base. A model already written `models/x` is kept. */
export function batchEmbedUrl(nativeBase: string, model: string): string {
  const name = model.startsWith("models/") ? model : `models/${model}`;
  return `${nativeBase}/${name}:batchEmbedContents`;
}

export interface NativeEmbedRequest {
  readonly model: string;
  readonly content: { readonly parts: ReadonlyArray<{ readonly text: string }> };
  readonly taskType: string;
}

/** The request body: one entry per text, each carrying its own task type. */
export function batchEmbedBody(model: string, texts: readonly string[], taskTypes: readonly string[]): { requests: NativeEmbedRequest[] } {
  const name = model.startsWith("models/") ? model : `models/${model}`;
  return { requests: texts.map((text, i) => ({ model: name, content: { parts: [{ text }] }, taskType: taskTypes[i]! })) };
}

/** `{embeddings: [{values}]}`, in request order. A short or empty answer is an error, never a misalignment. */
export function parseBatchEmbedResponse(payload: unknown, expected: number): number[][] {
  const rows = (payload as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(rows) || rows.length !== expected) {
    throw new Error(`embedding response carried ${Array.isArray(rows) ? rows.length : 0} vectors, expected ${expected}`);
  }
  return rows.map((row) => {
    const values = (row as { values?: unknown })?.values;
    if (!Array.isArray(values) || values.length === 0) throw new Error("embedding response carried a row with no vector");
    return values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  });
}
