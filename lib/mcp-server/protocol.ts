import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpAuthContext,
  type McpToolDescriptor,
  type McpToolResult,
} from "./types";

export type McpDispatchOutcome =
  | { kind: "response"; body: JsonRpcResponse }
  | { kind: "accepted" };

type ProtocolDeps = {
  listTools: (ctx: McpAuthContext) => McpToolDescriptor[] | Promise<McpToolDescriptor[]>;
  callTool: (ctx: McpAuthContext, name: string, args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
};

const KNOWN_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export async function handleMcpMessage(
  ctx: McpAuthContext,
  message: JsonRpcMessage,
  deps?: ProtocolDeps
): Promise<McpDispatchOutcome> {
  const resolvedDeps = deps ?? await loadDefaultDeps();
  if (!isJsonRpcRequest(message)) {
    return response(idOf(message), undefined, {
      code: JSONRPC_INVALID_REQUEST,
      message: "invalid JSON-RPC 2.0 request",
    });
  }

  const id = idOf(message);
  const notification = message.id === undefined;

  switch (message.method) {
    case "initialize": {
      const params = asRecord(message.params);
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return response(id, {
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "Trent runs governed AI-company operations. trent_run_agent returns a runId; poll trent_get_run. Approval gates, spend limits, RLS, and audit logging remain enforced inside Trent.",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return { kind: "accepted" };
    case "ping":
      return response(id, {});
    case "tools/list":
      return response(id, { tools: await resolvedDeps.listTools(ctx) });
    case "tools/call": {
      const params = asRecord(message.params);
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        return response(id, undefined, { code: JSONRPC_INVALID_PARAMS, message: "params.name is required" });
      }
      const args = asRecord(params.arguments);
      return response(id, await resolvedDeps.callTool(ctx, name, args));
    }
    default:
      if (notification) return { kind: "accepted" };
      return response(id, undefined, {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: `method not found: ${message.method}`,
      });
  }
}

async function loadDefaultDeps(): Promise<ProtocolDeps> {
  const registry = await import("./registry");
  return {
    listTools: registry.listMcpTools,
    callTool: registry.callMcpTool,
  };
}

function isJsonRpcRequest(message: unknown): message is Required<Pick<JsonRpcMessage, "jsonrpc" | "method">> & JsonRpcMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as JsonRpcMessage).jsonrpc === "2.0" &&
      typeof (message as JsonRpcMessage).method === "string"
  );
}

function idOf(message: JsonRpcMessage | null | undefined): string | number | null {
  const id = message?.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function response(id: string | number | null, result?: unknown, error?: { code: number; message: string }): McpDispatchOutcome {
  return {
    kind: "response",
    body: error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result },
  };
}
