export const MCP_APPROVAL_POLICIES = [
  "read_only_auto",
  "approve_once",
  "always_approve",
  "disabled",
] as const;

export type McpApprovalPolicy = typeof MCP_APPROVAL_POLICIES[number];
export type McpApprovalPolicies = Record<string, McpApprovalPolicy>;

export type McpPolicyToolLike = {
  name: string;
  description?: string;
  title?: string;
  annotations?: Record<string, unknown>;
};

const POLICY_SET = new Set<string>(MCP_APPROVAL_POLICIES);
const DESTRUCTIVE_RE = /\b(delete|destroy|refund|charge|payout|transfer|disable|revoke|remove|purge)\b/i;

export function isMcpApprovalPolicy(value: unknown): value is McpApprovalPolicy {
  return typeof value === "string" && POLICY_SET.has(value);
}

export function defaultMcpApprovalPolicyForTool(tool: McpPolicyToolLike): McpApprovalPolicy {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === true && annotations.destructiveHint !== true) return "read_only_auto";
  if (annotations.destructiveHint === true) return "always_approve";
  const text = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.replace(/[_:-]+/g, " ");
  if (DESTRUCTIVE_RE.test(text)) return "always_approve";
  return "approve_once";
}

export function normalizeMcpApprovalPolicies(input: {
  rawPolicies?: unknown;
  legacyReversibleTools?: unknown;
  discoveredTools?: McpPolicyToolLike[];
}): McpApprovalPolicies {
  const tools = input.discoveredTools ?? [];
  const knownToolNames = new Set(tools.map((tool) => tool.name));
  const legacyAuto = new Set(
    Array.isArray(input.legacyReversibleTools)
      ? input.legacyReversibleTools.filter((item): item is string => typeof item === "string")
      : Array.isArray(input.rawPolicies)
        ? input.rawPolicies.filter((item): item is string => typeof item === "string")
        : [],
  );
  const raw = isRecord(input.rawPolicies) && !Array.isArray(input.rawPolicies) ? input.rawPolicies : {};
  const policies: McpApprovalPolicies = {};

  for (const tool of tools) {
    const rawPolicy = raw[tool.name];
    policies[tool.name] = isMcpApprovalPolicy(rawPolicy)
      ? rawPolicy
      : legacyAuto.has(tool.name)
        ? "read_only_auto"
        : defaultMcpApprovalPolicyForTool(tool);
  }

  if (!tools.length && Object.keys(raw).length) {
    for (const [tool, policy] of Object.entries(raw)) {
      if (isMcpApprovalPolicy(policy)) policies[tool] = policy;
    }
  }
  for (const tool of legacyAuto) {
    if (!knownToolNames.size || knownToolNames.has(tool)) policies[tool] = "read_only_auto";
  }

  return policies;
}

export function mcpApprovalPolicyRequiresApproval(policy: McpApprovalPolicy): boolean {
  return policy !== "read_only_auto";
}

export function mcpApprovalPolicyAllowsExecution(policy: McpApprovalPolicy): boolean {
  return policy !== "disabled";
}

export function approvalPoliciesToLegacyAutoTools(policies: McpApprovalPolicies): string[] {
  return Object.entries(policies)
    .filter((entry): entry is [string, "read_only_auto"] => entry[1] === "read_only_auto")
    .map(([tool]) => tool)
    .sort();
}

export function mcpApprovalPolicyLabel(policy: McpApprovalPolicy): string {
  return policy.replace(/_/g, "-").replace("read-only-auto", "read-only auto").replace("approve-once", "approve once").replace("always-approve", "always approve");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
