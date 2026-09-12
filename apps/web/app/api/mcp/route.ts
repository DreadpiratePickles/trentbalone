import { NextResponse } from "next/server";
import { authenticateMcpRequest } from "@/lib/mcp-server/auth";
import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  type JsonRpcMessage,
} from "@/lib/mcp-server/types";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  }

  const ctx = await authenticateMcpRequest(request.headers.get("authorization"));
  if (!ctx) {
    return NextResponse.json({ error: "invalid_api_key_or_missing_mcp_scope" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(ctx.keyId, ctx.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  let message: JsonRpcMessage | JsonRpcMessage[];
  try {
    message = await request.json();
  } catch {
    return jsonRpcError(JSONRPC_PARSE_ERROR, "parse error: body must be JSON", 400);
  }

  if (Array.isArray(message)) {
    return jsonRpcError(JSONRPC_INVALID_REQUEST, "batch requests are not supported in v1", 400);
  }

  const { handleMcpMessage } = await import("@/lib/mcp-server/protocol");
  const outcome = await handleMcpMessage(ctx, message);
  if (outcome.kind === "accepted") return new NextResponse(null, { status: 202 });
  return NextResponse.json(outcome.body);
}

export function GET() {
  return NextResponse.json(
    { error: "method_not_allowed", hint: "POST JSON-RPC messages to this stateless MCP endpoint." },
    { status: 405, headers: { Allow: "POST" } }
  );
}

export function DELETE() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } });
}

function jsonRpcError(code: number, message: string, status: number): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status }
  );
}

function isAllowedOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const requestOrigin = new URL(request.url).origin;
  const configured = safeOrigin(process.env.NEXT_PUBLIC_APP_URL) ?? requestOrigin;
  return origin === requestOrigin || origin === configured;
}

function safeOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
