/**
 * `@trent/core` wrapper over `apps/web/lib/mcp-connector-catalog.ts`.
 *
 * A static gallery of 9 vetted MCP connectors plus the lookup that maps a
 * user-configured server (arbitrary name + URL) onto one of them, which is how
 * a connector inherits its default approval policy and risk tier. Pure data and
 * pure functions; type-only imports in the app, so a thin typed re-export.
 *
 * Wraps: apps/web/lib/mcp-connector-catalog.ts
 */

import {
  MCP_CONNECTOR_GALLERY as LIB_GALLERY,
  MCP_MARKETPLACE_SOURCES as LIB_SOURCES,
  findMcpConnectorTemplateForServer as libFindTemplate,
  mcpConnectorGrantLabel as libGrantLabel,
  mcpConnectorSourceLabel as libSourceLabel,
} from "@/lib/mcp-connector-catalog";

// Locally declared so consumers do not inherit @/lib/mcp-policy + mcp-transport.
export type McpTransport = "http" | "sse" | "stdio";

export type McpApprovalPolicy = "read_only_auto" | "approve_once" | "always_approve" | "disabled";

export type McpToolPolicyClass =
  | "read_only"
  | "write"
  | "customer_facing"
  | "money_moving"
  | "destructive"
  | "deploy"
  | "secret_access";

export type McpConnectorSource = "official" | "gateway" | "community" | "self_hosted";
export type McpConnectorAuthMode = "oauth" | "token" | "none" | "provider_url";
export type McpConnectorGrantMode =
  | "oauth_user"
  | "bearer_token"
  | "provider_url"
  | "none"
  | "local_stdio";

export type McpConnectorTemplate = {
  id: string;
  name: string;
  owner: string;
  source: McpConnectorSource;
  category: string;
  description: string;
  transport: McpTransport;
  url: string;
  authMode: McpConnectorAuthMode;
  grantMode: McpConnectorGrantMode;
  trustScore: number;
  riskTier: "low" | "medium" | "high";
  policyClasses: McpToolPolicyClass[];
  supportsResources: boolean;
  supportsPrompts: boolean;
  supportsAppsUi: boolean;
  tags: string[];
  defaultPolicy: McpApprovalPolicy;
};

export type McpMarketplaceSource = {
  source: McpConnectorSource;
  label: string;
  description: string;
};

/** The four provenance classes a connector can come from. */
export const MCP_MARKETPLACE_SOURCES: readonly McpMarketplaceSource[] =
  LIB_SOURCES as unknown as readonly McpMarketplaceSource[];

/** The vetted connector gallery. */
export const MCP_CONNECTOR_GALLERY: readonly McpConnectorTemplate[] =
  LIB_GALLERY as unknown as readonly McpConnectorTemplate[];

/**
 * Resolve a configured MCP server onto a gallery template — by exact name, by
 * URL host, or by tag match against the server's name. Undefined when nothing
 * matches, in which case the caller must not inherit any default policy.
 */
export function findMcpConnectorTemplateForServer(input: {
  name: string;
  url: string;
}): McpConnectorTemplate | undefined {
  return libFindTemplate(input) as McpConnectorTemplate | undefined;
}

/** Human label for a connector provenance class. */
export function mcpConnectorSourceLabel(source: McpConnectorSource): string {
  return libSourceLabel(source);
}

/** Human label for how a connector's credential is granted. */
export function mcpConnectorGrantLabel(mode: McpConnectorGrantMode): string {
  return libGrantLabel(mode);
}

/** Look one connector template up by its gallery id. */
export function mcpConnectorTemplateById(id: string): McpConnectorTemplate | undefined {
  return MCP_CONNECTOR_GALLERY.find((template) => template.id === id);
}
