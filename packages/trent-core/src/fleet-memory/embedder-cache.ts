/**
 * The embedder's content-addressed disk cache, `<profileDir>/cache/embeddings/` (0700, files 0600).
 * Moved out of `embedder.ts` unchanged for a symmetric call, so that file stays under the house
 * 500-line limit, and [P2-13] keyed by task type as well: a text embedded as a RETRIEVAL_QUERY, as a
 * RETRIEVAL_DOCUMENT and with no task type is three vectors in three spaces, and a vector from one
 * must never answer a call made in another. A symmetric entry's key is byte-identical to the one it
 * had before task types existed, so an existing cache keeps every hit it had.
 *
 * No key is ever written here. Every failure is a cache miss, never a run failure.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Cache-key field separator, so "ab"+"c" and "a"+"bc" cannot hash alike. */
export const CACHE_SEPARATOR = "\u0000";
const CACHE_DIR_MODE = 0o700;
const CACHE_FILE_MODE = 0o600;

/**
 * sha256 over the endpoint, the model AND the text. Model plus text is the minimum (a model change
 * must be a miss); the endpoint joins them because one model NAME on two hosts is two spaces. A task
 * type, when there is one, is a fourth field.
 */
function cacheKey(scope: string, model: string, text: string, taskType: string | undefined): string {
  const hash = createHash("sha256");
  for (const part of taskType === undefined ? [scope, model, text] : [scope, model, text, taskType]) hash.update(part).update(CACHE_SEPARATOR);
  return hash.digest("hex");
}

function encodeVector(vector: readonly number[]): string {
  return Buffer.from(Float32Array.from(vector).buffer).toString("base64");
}

function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, "base64");
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return Array.from(new Float32Array(copy));
}

export class EmbeddingCache {
  readonly #dir: string;
  readonly #scope: string;

  constructor(profileDir: string, scope: string) {
    this.#dir = path.join(profileDir, "cache", "embeddings");
    this.#scope = scope;
  }

  read(model: string, text: string, taskType?: string): number[] | undefined {
    try {
      const raw = fs.readFileSync(this.#fileFor(model, text, taskType), "utf8");
      const parsed = JSON.parse(raw) as { model?: unknown; vector?: unknown; task_type?: unknown };
      if (parsed.model !== model || typeof parsed.vector !== "string") return undefined;
      if ((parsed.task_type ?? undefined) !== taskType) return undefined;
      return decodeVector(parsed.vector);
    } catch {
      return undefined;
    }
  }

  write(model: string, text: string, vector: readonly number[], taskType?: string): void {
    const file = this.#fileFor(model, text, taskType);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: CACHE_DIR_MODE });
      fs.chmodSync(this.#dir, CACHE_DIR_MODE);
      const entry = taskType === undefined
        ? { model, dims: vector.length, vector: encodeVector(vector) }
        : { model, task_type: taskType, dims: vector.length, vector: encodeVector(vector) };
      fs.writeFileSync(file, JSON.stringify(entry), { mode: CACHE_FILE_MODE });
    } catch {
      /* a cache that cannot be written is still a working embedder */
    }
  }

  // Two hex characters of fan-out: one flat directory would hold every step ever recalled.
  #fileFor(model: string, text: string, taskType: string | undefined): string {
    const key = cacheKey(this.#scope, model, text, taskType);
    return path.join(this.#dir, key.slice(0, 2), `${key}.json`);
  }
}
