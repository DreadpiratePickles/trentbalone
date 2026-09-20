/**
 * U5 / G9 — Trent as an MCP server (`trent mcp serve`): the profile's toolsets as MCP tools,
 * dispatched through the same wrapper chain a seat's call takes, approvals parked as rows the
 * founder settles with `trent approvals`, stdio or Streamable HTTP with the A2A bearer rule.
 */
export { approvalKey, createMcpApprovalGate, MCP_APPROVAL_SURFACE, type McpApproval, type McpApprovalGate, type McpApprovalGateOptions, type McpApprovalRequest } from "./approvals.js";
export { buildToolCatalog, catalogToolNames, EXCLUDED_ADAPTERS, type McpInputSchema, type TrentMcpTool } from "./catalog.js";
export { parseInstructionBlock, PROSE_TOOL_SCHEMAS, toolInputSchema } from "./schemas.js";
export { createTrentMcpServer, MCP_SERVER_NAME, MCP_SURFACE, type TrentMcpServer, type TrentMcpServerOptions } from "./server.js";
export {
  createMcpHttpServer,
  isLoopbackHost,
  MCP_DEFAULT_HOST,
  MCP_DEFAULT_PORT,
  MCP_HTTP_PATH,
  MCP_UNAUTHORIZED,
  serveStdio,
  type McpHttpOptions,
  type McpHttpServer,
} from "./transport.js";
