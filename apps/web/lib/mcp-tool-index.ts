import type { McpDiscoveredTool, McpServerRecord } from "@/lib/mcp-store";
import {
  classifyMcpToolPolicyClasses,
  defaultMcpApprovalPolicyForTool,
  mcpApprovalPolicyLabel,
  mcpPolicyClassLabel,
  mcpToolRiskLabel,
  type McpToolPolicyClass,
} from "@/lib/mcp-policy";
import {
  findMcpConnectorTemplateForServer,
  mcpConnectorSourceLabel,
  type McpConnectorSource,
} from "@/lib/mcp-connector-catalog";

export type McpServerRank = {
  server: McpServerRecord;
  score: number;
  matchedTerms: string[];
};

export type McpToolInventoryItem = {
  id: string;
  serverId: string;
  serverName: string;
  connectorSource: McpConnectorSource | "unknown";
  owner: string;
  adapterName: string;
  toolName: string;
  displayName: string;
  description: string;
  available: boolean;
  whyAvailable: string;
  evidence: string;
  approvalPolicy: string;
  policyClasses: McpToolPolicyClass[];
  risk: "low" | "medium" | "high" | "critical";
  schema: {
    input: "present" | "missing";
    output: "present" | "missing";
  };
  lastProof: {
    status: "passed" | "failed" | "pending" | "not_run";
    at?: string;
    summary: string;
  };
  lastCall: {
    status: "not_recorded" | "recorded";
    at?: string;
    summary: string;
  };
};

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "for", "of", "in", "on", "with", "by", "from", "this", "that",
  "do", "run", "make", "daily", "operator", "sweep",
]);

export function rankMcpServersForTask(
  servers: McpServerRecord[],
  query: string,
  options: { limit?: number } = {},
): McpServerRank[] {
  const limit = Math.max(1, options.limit ?? 4);
  const queryTerms = tokenize(query);
  const ranked = servers
    .filter((server) => server.enabled && server.status === "connected")
    .map((server) => rankServer(server, queryTerms))
    .sort((a, b) => b.score - a.score || b.server.discoveredTools.length - a.server.discoveredTools.length || a.server.name.localeCompare(b.server.name));

  const positive = ranked.filter((item) => item.score > 0);
  return (positive.length ? positive : ranked).slice(0, limit);
}

export function buildMcpToolInventory(servers: McpServerRecord[]): McpToolInventoryItem[] {
  return servers.flatMap((server) => {
    const template = findMcpConnectorTemplateForServer(server);
    const source = template?.source ?? "unknown";
    const owner = template?.owner ?? server.name;
    const allowed = new Set(server.toolAllowlist.length ? server.toolAllowlist : server.discoveredTools.map((tool) => tool.name));
    const discovered: McpDiscoveredTool[] = server.discoveredTools.length
      ? server.discoveredTools
      : server.toolAllowlist.map((name) => ({ name, description: "" }));

    return discovered.map((tool) => {
      const policy = server.approvalPolicies?.[tool.name] ?? defaultMcpApprovalPolicyForTool(tool);
      const policyClasses = classifyMcpToolPolicyClasses(tool);
      const available = server.enabled && server.status === "connected" && allowed.has(tool.name);
      return {
        id: `${server.id}:${tool.name}`,
        serverId: server.id,
        serverName: server.name,
        connectorSource: source,
        owner,
        adapterName: adapterName(server.name),
        toolName: tool.name,
        displayName: tool.title ?? tool.name,
        description: tool.description ?? "",
        available,
        whyAvailable: available
          ? `${server.name} is enabled, connected, and ${allowed.has(tool.name) ? "the tool is allowlisted/discovered" : "the tool is discoverable"}. Policy: ${mcpApprovalPolicyLabel(policy)}.`
          : unavailableReason(server, tool.name, allowed),
        evidence: server.status === "connected"
          ? `Discovery proof from ${server.updatedAt}; source ${source === "unknown" ? "unclassified" : mcpConnectorSourceLabel(source)}.`
          : server.lastError
            ? `Last health error: ${server.lastError}`
            : `No passing discovery proof recorded yet.`,
        approvalPolicy: policy,
        policyClasses,
        risk: mcpToolRiskLabel(policyClasses),
        schema: {
          input: tool.inputSchema ? "present" : "missing",
          output: tool.outputSchema ? "present" : "missing",
        },
        lastProof: {
          status: server.status === "connected" ? "passed" : server.status === "error" ? "failed" : server.status === "configured" ? "pending" : "not_run",
          at: server.updatedAt,
          summary: server.status === "connected"
            ? `Discovery returned ${server.discoveredTools.length} tool(s).`
            : server.lastError ?? `Connector is ${server.status}.`,
        },
        lastCall: {
          status: "not_recorded",
          summary: "No MCP tool call audit row has been loaded into this inventory view yet.",
        },
      } satisfies McpToolInventoryItem;
    });
  });
}

export function searchMcpToolInventory(items: McpToolInventoryItem[], query: string): McpToolInventoryItem[] {
  const terms = tokenize(query);
  if (!terms.length) return items;
  return items
    .map((item) => ({ item, score: scoreInventoryItem(item, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.serverName.localeCompare(b.item.serverName) || a.item.toolName.localeCompare(b.item.toolName))
    .map((entry) => entry.item);
}

function rankServer(server: McpServerRecord, queryTerms: string[]): McpServerRank {
  const nameText = normalizeText(server.name);
  const toolText = normalizeText(server.discoveredTools.map((tool) => [
    tool.name,
    tool.title ?? "",
    tool.description,
    JSON.stringify(tool.annotations ?? {}),
  ].join(" ")).join(" "));
  const urlText = normalizeText(server.url);
  const matchedTerms: string[] = [];
  let score = 0;
  let firstMatchIndex = Number.POSITIVE_INFINITY;

  for (const [index, term] of queryTerms.entries()) {
    if (nameText.includes(term)) {
      score += 4;
      matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
    if (toolText.includes(term)) {
      score += 2;
      if (!matchedTerms.includes(term)) matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
    if (urlText.includes(term)) {
      score += 1;
      if (!matchedTerms.includes(term)) matchedTerms.push(term);
      firstMatchIndex = Math.min(firstMatchIndex, index);
    }
  }

  if (Number.isFinite(firstMatchIndex)) score += (queryTerms.length - firstMatchIndex) / 100;
  if (score === 0 && server.discoveredTools.length) score = 0.1;
  return { server, score, matchedTerms };
}

function tokenize(value: string): string[] {
  return Array.from(new Set(normalizeText(value).split(/\s+/).filter((term) => term.length > 2 && !STOP_WORDS.has(term))));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function adapterName(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${slug || "server"}`;
}

function unavailableReason(server: McpServerRecord, tool: string, allowed: Set<string>): string {
  if (!server.enabled) return `${server.name} is disabled.`;
  if (server.status !== "connected") return `${server.name} is ${server.status}; run Discover or Test read before agents can use ${tool}.`;
  if (!allowed.has(tool)) return `${tool} is not allowlisted for ${server.name}.`;
  return `${tool} is not currently available.`;
}

function scoreInventoryItem(item: McpToolInventoryItem, terms: string[]): number {
  const haystack = normalizeText([
    item.serverName,
    item.owner,
    item.toolName,
    item.displayName,
    item.description,
    item.risk,
    item.connectorSource,
    item.policyClasses.map(mcpPolicyClassLabel).join(" "),
    item.approvalPolicy,
  ].join(" "));
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
