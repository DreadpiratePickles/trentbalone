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
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return { ok: false, error: "private or loopback MCP endpoints are blocked" };
  }
  return { ok: true, url: rawUrl, transport };
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index])) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
