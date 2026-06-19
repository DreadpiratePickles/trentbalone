import type { McpTransport } from "@/lib/mcp-transport";
import type { McpApprovalPolicy } from "@/lib/mcp-policy";

export type McpConnectorTemplate = {
  id: string;
  name: string;
  category: string;
  description: string;
  transport: McpTransport;
  url: string;
  authMode: "oauth" | "token" | "none" | "provider_url";
  trustScore: number;
  riskTier: "low" | "medium" | "high";
  supportsResources: boolean;
  supportsPrompts: boolean;
  tags: string[];
  defaultPolicy: McpApprovalPolicy;
};

export const MCP_CONNECTOR_GALLERY: McpConnectorTemplate[] = [
  {
    id: "stripe",
    name: "Stripe",
    category: "Revenue",
    description: "Payments, billing, subscriptions, refunds, and Stripe docs through the official MCP server.",
    transport: "http",
    url: "https://mcp.stripe.com",
    authMode: "token",
    trustScore: 92,
    riskTier: "high",
    supportsResources: true,
    supportsPrompts: false,
    tags: ["payments", "billing", "finance"],
    defaultPolicy: "always_approve",
  },
  {
    id: "github",
    name: "GitHub",
    category: "Engineering",
    description: "Issues, pull requests, repository context, code search, and project automation.",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    authMode: "oauth",
    trustScore: 90,
    riskTier: "high",
    supportsResources: true,
    supportsPrompts: true,
    tags: ["code", "issues", "pull requests"],
    defaultPolicy: "approve_once",
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "Reliability",
    description: "Production issue search, stack traces, releases, and diagnostics via the approved local preset.",
    transport: "stdio",
    url: "stdio://sentry",
    authMode: "token",
    trustScore: 86,
    riskTier: "medium",
    supportsResources: true,
    supportsPrompts: false,
    tags: ["errors", "observability", "incidents"],
    defaultPolicy: "approve_once",
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    category: "Knowledge",
    description: "Trusted Microsoft documentation, article fetch, and code sample search with no auth required.",
    transport: "http",
    url: "https://learn.microsoft.com/api/mcp",
    authMode: "none",
    trustScore: 95,
    riskTier: "low",
    supportsResources: true,
    supportsPrompts: false,
    tags: ["docs", "azure", "learn"],
    defaultPolicy: "read_only_auto",
  },
  {
    id: "notion",
    name: "Notion",
    category: "Knowledge",
    description: "Workspace search, page retrieval, and governed content updates through Notion MCP.",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    authMode: "oauth",
    trustScore: 82,
    riskTier: "medium",
    supportsResources: true,
    supportsPrompts: true,
    tags: ["wiki", "docs", "workspace"],
    defaultPolicy: "approve_once",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    category: "Work Management",
    description: "Jira and Confluence context, Rovo search, issue/page operations, and project workflows.",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    authMode: "oauth",
    trustScore: 84,
    riskTier: "high",
    supportsResources: true,
    supportsPrompts: true,
    tags: ["jira", "confluence", "projects"],
    defaultPolicy: "approve_once",
  },
  {
    id: "zapier",
    name: "Zapier",
    category: "Automation",
    description: "A governed bridge to thousands of app actions; paste the account-specific MCP server URL from Zapier.",
    transport: "http",
    url: "https://mcp.zapier.com",
    authMode: "provider_url",
    trustScore: 78,
    riskTier: "high",
    supportsResources: false,
    supportsPrompts: true,
    tags: ["automation", "apps", "actions"],
    defaultPolicy: "always_approve",
  },
  {
    id: "pipedream",
    name: "Pipedream",
    category: "Automation",
    description: "Connectors for thousands of APIs with user-scoped auth through Pipedream Connect.",
    transport: "http",
    url: "https://mcp.pipedream.net/v2",
    authMode: "oauth",
    trustScore: 80,
    riskTier: "high",
    supportsResources: false,
    supportsPrompts: true,
    tags: ["apis", "automation", "workflows"],
    defaultPolicy: "always_approve",
  },
];
