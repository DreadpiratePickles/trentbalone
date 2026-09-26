/**
 * The one HTTP path every fetch-based adapter uses: pinned base URL, timeout, JSON in/out,
 * and errors that never carry a token. Adapters pass headers; this never logs them.
 */

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly platform: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HttpRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings/bytes/FormData are sent as-is. */
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  text: string;
  json: T | undefined;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Removes anything that looks like a bearer token or bot token from an error string. */
export function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

export async function httpRequest<T = unknown>(
  fetchImpl: typeof fetch,
  platform: string,
  url: string,
  request: HttpRequest = {},
  secretsToRedact: Array<string | undefined> = [],
): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  request.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  let body: BodyInit | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === "string" || request.body instanceof Uint8Array || request.body instanceof FormData) {
      body = request.body as BodyInit;
    } else {
      body = JSON.stringify(request.body);
      headers["content-type"] ??= "application/json";
    }
  }
  try {
    const res = await fetchImpl(url, { method: request.method ?? "GET", headers, body, signal: controller.signal });
    const text = await res.text();
    let json: T | undefined;
    const type = res.headers.get("content-type") ?? "";
    if (text !== "" && (type.includes("json") || /^[[{]/.test(text.trimStart()))) {
      try {
        json = JSON.parse(text) as T;
      } catch {
        json = undefined;
      }
    }
    return { status: res.status, headers: res.headers, text, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransportError(`${platform}: ${redact(message, secretsToRedact)}`, platform);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws a TransportError for non-2xx, with the body trimmed and redacted. */
export function expectOk<T>(platform: string, res: HttpResponse<T>, secrets: Array<string | undefined> = []): T {
  if (res.status < 200 || res.status >= 300) {
    throw new TransportError(
      `${platform}: HTTP ${res.status} ${redact(res.text.slice(0, 300), secrets)}`,
      platform,
      res.status,
      redact(res.text, secrets),
    );
  }
  return res.json as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Buttons rendered as text for platforms without interactive components. */
export function buttonsAsText(rows: Array<Array<{ id: string; label: string }>> | undefined): string {
  if (!rows || rows.length === 0) return "";
  return "\n\n" + rows.flat().map((b) => `[${b.label}] ${b.id}`).join("\n");
}

// [H4] An adapter without the `files` capability names what it could not send, so the loss is
// visible in the chat instead of silent (rulebook section 6: partial failure must be visible).
export function unsentAttachmentsAsText(attachments: Array<{ filename: string }> | undefined): string {
  if (!attachments || attachments.length === 0) return "";
  return "\n\n" + attachments.map((a) => `[attachment not sent: ${a.filename}]`).join("\n");
}

/** Copies bytes into a plain ArrayBuffer-backed view, which is what Blob accepts under strict lib typings. */
export function toBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(data.byteLength));
  copy.set(data);
  return copy;
}
