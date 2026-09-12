/** Parse a JSON error body from a failed API response. Never throws. */
export async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
    if (typeof body.message === "string" && body.message.trim()) return body.message;
  } catch {
    // non-JSON body
  }
  return `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`;
}
