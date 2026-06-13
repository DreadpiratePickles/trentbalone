export type McpTransport = "http" | "sse" | "stdio";

const ALLOWED_STDIO_PRESETS = new Set(["stdio://sentry"]);

export function normalizeMcpTransport(value: unknown): McpTransport | null {
  if (value === undefined || value === null || value === "") return "http";
  if (value === "http" || value === "sse" || value === "stdio") return value;
  return null;
}

export function isAllowedStdioMcpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  const canonical = parsed.pathname === "/" && !parsed.search && !parsed.hash
    ? `${parsed.protocol}//${parsed.host}`
    : parsed.toString();
  return ALLOWED_STDIO_PRESETS.has(canonical);
}

export function validateMcpServerTarget(input: {
  url: string;
  transport?: unknown;
}): { ok: true; url: string; transport: McpTransport } | { ok: false; error: string } {
  const transport = normalizeMcpTransport(input.transport);
  if (!transport) return { ok: false, error: "unsupported MCP transport" };

  const rawUrl = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: transport === "stdio" ? "unsupported stdio MCP preset" : "url must be a valid http(s) URL" };
  }

  if (transport === "stdio") {
    if (!isAllowedStdioMcpUrl(rawUrl)) return { ok: false, error: "unsupported stdio MCP preset" };
    return { ok: true, url: "stdio://sentry", transport };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url must be a valid http(s) URL" };
  }
  return { ok: true, url: rawUrl, transport };
}
