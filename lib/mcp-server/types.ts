import type { ProxyScope, ProxyTier } from "@/lib/ai-proxy/types";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_SERVER_INFO = {
  name: "trent-os",
  version: "0.1.0",
};

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;

export type McpAuthContext = {
  companyId: string;
  keyId: string;
  maskedKey: string;
  scopes: ProxyScope[];
  tier: ProxyTier;
};

export type JsonRpcId = string | number | null;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type McpToolContent = {
  type: "text";
  text: string;
};

export type McpToolResult = {
  content: McpToolContent[];
  isError?: boolean;
};

export type JsonSchemaObject = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
};

export type McpToolDefinition = McpToolDescriptor & {
  requiredScope: ProxyScope;
  handler: (ctx: McpAuthContext, args: Record<string, unknown>) => Promise<unknown>;
};

export type McpResourceDescriptor = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

export type McpResourceReadResult = {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text: string;
  }>;
};

export type McpPromptDescriptor = {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
};

export type McpPromptResult = {
  messages: Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
};
