import type { McpTransport } from "@/lib/mcp-transport";
import type { McpApprovalPolicy, McpToolPolicyClass } from "@/lib/mcp-policy";

export type McpConnectorSource = "official" | "gateway" | "community" | "self_hosted";
export type McpConnectorAuthMode = "oauth" | "token" | "none" | "provider_url";
export type McpConnectorGrantMode = "oauth_user" | "bearer_token" | "provider_url" | "none" | "local_stdio";

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

export const MCP_MARKETPLACE_SOURCES: Array<{
  source: McpConnectorSource;
  label: string;
  description: string;
}> = [
  { source: "official", label: "Official", description: "Provider-operated connectors with the strongest provenance." },
  { source: "gateway", label: "Gateway", description: "Connector hubs that broker OAuth and many third-party APIs." },
  { source: "community", label: "Community", description: "Useful connectors that need extra review before production use." },
  { source: "self_hosted", label: "Self-hosted", description: "Your own internal MCP servers, usually behind company infrastructure." },
];

export const MCP_CONNECTOR_GALLERY: McpConnectorTemplate[] = [
  {
    id: "stripe",
    name: "Stripe",
    owner: "Stripe",
    source: "official",
    category: "Revenue",
    description: "Payments, billing, subscriptions, refunds, and Stripe docs through the official MCP server.",
    transport: "http",
    url: "https://mcp.stripe.com",
    authMode: "token",
    grantMode: "bearer_token",
    trustScore: 92,
    riskTier: "high",
    policyClasses: ["read_only", "money_moving", "customer_facing"],
    supportsResources: true,
    supportsPrompts: false,
    supportsAppsUi: false,
    tags: ["payments", "billing", "finance"],
    defaultPolicy: "always_approve",
  },
  {
    id: "github",
    name: "GitHub",
    owner: "GitHub",
    source: "official",
    category: "Engineering",
    description: "Issues, pull requests, repository context, code search, and project automation.",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authMode: "oauth",
    grantMode: "oauth_user",
    trustScore: 90,
    riskTier: "high",
    policyClasses: ["read_only", "write", "deploy"],
    supportsResources: true,
    supportsPrompts: true,
    supportsAppsUi: false,
    tags: ["code", "issues", "pull requests"],
    defaultPolicy: "approve_once",
  },
  {
    id: "sentry",
    name: "Sentry",
    owner: "Sentry",
    source: "official",
    category: "Reliability",
    description: "Production issue search, stack traces, releases, and diagnostics via the approved local preset.",
    transport: "stdio",
    url: "stdio://sentry",
    authMode: "token",
    grantMode: "local_stdio",
    trustScore: 86,
    riskTier: "medium",
    policyClasses: ["read_only", "write"],
    supportsResources: true,
    supportsPrompts: false,
    supportsAppsUi: false,
    tags: ["errors", "observability", "incidents"],
    defaultPolicy: "approve_once",
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    owner: "Microsoft",
    source: "official",
    category: "Knowledge",
    description: "Trusted Microsoft documentation, article fetch, and code sample search with no auth required.",
    transport: "http",
    url: "https://learn.microsoft.com/api/mcp",
    authMode: "none",
    grantMode: "none",
    trustScore: 95,
    riskTier: "low",
    policyClasses: ["read_only"],
    supportsResources: true,
    supportsPrompts: false,
    supportsAppsUi: false,
    tags: ["docs", "azure", "learn"],
    defaultPolicy: "read_only_auto",
  },
  {
    id: "notion",
    name: "Notion",
    owner: "Notion",
    source: "official",
    category: "Knowledge",
    description: "Workspace search, page retrieval, and governed content updates through Notion MCP.",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    authMode: "oauth",
    grantMode: "oauth_user",
    trustScore: 82,
    riskTier: "medium",
    policyClasses: ["read_only", "write", "customer_facing"],
    supportsResources: true,
    supportsPrompts: true,
    supportsAppsUi: false,
    tags: ["wiki", "docs", "workspace"],
    defaultPolicy: "approve_once",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    owner: "Atlassian",
    source: "official",
    category: "Work Management",
    description: "Jira and Confluence context, Rovo search, issue/page operations, and project workflows.",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    authMode: "oauth",
    grantMode: "oauth_user",
    trustScore: 84,
    riskTier: "high",
    policyClasses: ["read_only", "write", "customer_facing"],
    supportsResources: true,
    supportsPrompts: true,
    supportsAppsUi: false,
    tags: ["jira", "confluence", "projects"],
    defaultPolicy: "approve_once",
  },
  {
    id: "zapier",
    name: "Zapier",
    owner: "Zapier",
    source: "gateway",
    category: "Automation",
    description: "A governed bridge to thousands of app actions; paste the account-specific MCP server URL from Zapier.",
    transport: "http",
    url: "https://mcp.zapier.com",
    authMode: "provider_url",
    grantMode: "provider_url",
    trustScore: 78,
    riskTier: "high",
    policyClasses: ["write", "customer_facing", "money_moving"],
    supportsResources: false,
    supportsPrompts: true,
    supportsAppsUi: false,
    tags: ["automation", "apps", "actions"],
    defaultPolicy: "always_approve",
  },
  {
    id: "pipedream",
    name: "Pipedream",
    owner: "Pipedream",
    source: "gateway",
    category: "Automation",
    description: "Connectors for thousands of APIs with user-scoped auth through Pipedream Connect.",
    transport: "http",
    url: "https://mcp.pipedream.net/v2",
    authMode: "oauth",
    grantMode: "oauth_user",
    trustScore: 80,
    riskTier: "high",
    policyClasses: ["write", "customer_facing", "money_moving"],
    supportsResources: false,
    supportsPrompts: true,
    supportsAppsUi: false,
    tags: ["apis", "automation", "workflows"],
    defaultPolicy: "always_approve",
  },
  {
    id: "internal-http",
    name: "Internal HTTP MCP",
    owner: "Your company",
    source: "self_hosted",
    category: "Internal",
    description: "Connect a company-hosted MCP server after security review and allowlist validation.",
    transport: "http",
    url: "https://mcp.your-company.example/mcp",
    authMode: "token",
    grantMode: "bearer_token",
    trustScore: 62,
    riskTier: "high",
    policyClasses: ["read_only", "write", "secret_access"],
    supportsResources: true,
    supportsPrompts: true,
    supportsAppsUi: true,
    tags: ["internal", "self-hosted", "tools"],
    defaultPolicy: "always_approve",
  },
];

export function findMcpConnectorTemplateForServer(input: { name: string; url: string }): McpConnectorTemplate | undefined {
  const normalizedName = normalize(input.name);
  const normalizedUrl = input.url.toLowerCase();
  return MCP_CONNECTOR_GALLERY.find((template) => {
    return normalize(template.name) === normalizedName
      || normalizedUrl.includes(template.url.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, ""))
      || template.tags.some((tag) => normalizedName.includes(normalize(tag)));
  });
}

export function mcpConnectorSourceLabel(source: McpConnectorSource): string {
  return MCP_MARKETPLACE_SOURCES.find((item) => item.source === source)?.label ?? source.replace(/_/g, " ");
}

export function mcpConnectorGrantLabel(mode: McpConnectorGrantMode): string {
  if (mode === "oauth_user") return "OAuth / per-user grant";
  if (mode === "bearer_token") return "Bearer token";
  if (mode === "provider_url") return "Provider URL";
  if (mode === "local_stdio") return "Local stdio credential";
  return "No credential";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
