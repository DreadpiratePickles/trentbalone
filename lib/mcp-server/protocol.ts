import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type McpAuthContext,
  type McpPromptDescriptor,
  type McpPromptResult,
  type McpResourceDescriptor,
  type McpResourceReadResult,
  type McpToolDescriptor,
  type McpToolResult,
} from "./types";

export type McpDispatchOutcome =
  | { kind: "response"; body: JsonRpcResponse }
  | { kind: "accepted" };

type ProtocolDeps = {
  listTools: (ctx: McpAuthContext) => McpToolDescriptor[] | Promise<McpToolDescriptor[]>;
  callTool: (ctx: McpAuthContext, name: string, args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
  listResources?: (ctx: McpAuthContext) => McpResourceDescriptor[] | Promise<McpResourceDescriptor[]>;
  readResource?: (ctx: McpAuthContext, uri: string) => McpResourceReadResult | Promise<McpResourceReadResult>;
  listPrompts?: (ctx: McpAuthContext) => McpPromptDescriptor[] | Promise<McpPromptDescriptor[]>;
  getPrompt?: (ctx: McpAuthContext, name: string, args: Record<string, unknown>) => McpPromptResult | Promise<McpPromptResult>;
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
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "Trent runs governed AI-company operations. Call trent_list_app_solo_options before App-Solo work, then use trent_run_agent with engine=solo; optionally pass appId to choose the seat-specific app. trent_run_agent returns runId, productReviewPlan, and nextCall for structured polling. Follow nextCall to trent_get_run, inspect nextAction for poll/approval/review guidance, inspect evidenceSummary for verification counts, inspect productArtifactIndex for preview/artifact/check/command evidence, and inspect productReview for delivery readiness. Approval gates, spend limits, RLS, and audit logging remain enforced inside Trent.",
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
    case "resources/list":
      if (!resolvedDeps.listResources) {
        return response(id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: resources/list" });
      }
      return response(id, { resources: await resolvedDeps.listResources(ctx) });
    case "resources/read": {
      if (!resolvedDeps.readResource) {
        return response(id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: resources/read" });
      }
      const params = asRecord(message.params);
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (!uri) {
        return response(id, undefined, { code: JSONRPC_INVALID_PARAMS, message: "params.uri is required" });
      }
      return response(id, await resolvedDeps.readResource(ctx, uri));
    }
    case "prompts/list":
      if (!resolvedDeps.listPrompts) {
        return response(id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: prompts/list" });
      }
      return response(id, { prompts: await resolvedDeps.listPrompts(ctx) });
    case "prompts/get": {
      if (!resolvedDeps.getPrompt) {
        return response(id, undefined, { code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: prompts/get" });
      }
      const params = asRecord(message.params);
      const name = typeof params.name === "string" ? params.name : "";
      if (!name) {
        return response(id, undefined, { code: JSONRPC_INVALID_PARAMS, message: "params.name is required" });
      }
      return response(id, await resolvedDeps.getPrompt(ctx, name, asRecord(params.arguments)));
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
    listResources: registry.listMcpResources,
    readResource: registry.readMcpResource,
    listPrompts: registry.listMcpPrompts,
    getPrompt: registry.getMcpPrompt,
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
