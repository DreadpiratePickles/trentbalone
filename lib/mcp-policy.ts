export const MCP_APPROVAL_POLICIES = [
  "read_only_auto",
  "approve_once",
  "always_approve",
  "disabled",
] as const;

export type McpApprovalPolicy = typeof MCP_APPROVAL_POLICIES[number];
export type McpApprovalPolicies = Record<string, McpApprovalPolicy>;

export const MCP_TOOL_POLICY_CLASSES = [
  "read_only",
  "write",
  "customer_facing",
  "money_moving",
  "destructive",
  "deploy",
  "secret_access",
] as const;

export type McpToolPolicyClass = typeof MCP_TOOL_POLICY_CLASSES[number];

export type McpPolicyToolLike = {
  name: string;
  description?: string;
  title?: string;
  annotations?: Record<string, unknown>;
};

const POLICY_SET = new Set<string>(MCP_APPROVAL_POLICIES);
const READ_RE = /\b(read|list|get|search|query|fetch|find|inspect|describe|lookup|retrieve)\b/i;
const WRITE_RE = /\b(create|update|edit|write|send|post|comment|assign|set|add|append|publish)\b/i;
const CUSTOMER_FACING_RE = /\b(customer|contact|lead|crm|email|message|ticket|support|subscriber|attio|hubspot|salesforce)\b/i;
const MONEY_RE = /\b(charge|refund|payment|payout|transfer|invoice|subscription|billing|stripe|bank|balance|checkout)\b/i;
const DESTRUCTIVE_RE = /\b(delete|destroy|refund|charge|payout|transfer|disable|revoke|remove|purge|drop|archive)\b/i;
const DEPLOY_RE = /\b(deploy|release|rollback|build|domain|environment|hosting|vercel|railway|render|cloudflare)\b/i;
const SECRET_RE = /\b(secret|token|key|password|credential|env|private key|api key)\b/i;

export function isMcpApprovalPolicy(value: unknown): value is McpApprovalPolicy {
  return typeof value === "string" && POLICY_SET.has(value);
}

export function defaultMcpApprovalPolicyForTool(tool: McpPolicyToolLike): McpApprovalPolicy {
  const classes = classifyMcpToolPolicyClasses(tool);
  if (tool.annotations?.readOnlyHint === true && classes.length === 1 && classes[0] === "read_only") return "read_only_auto";
  if (classes.some((item) => item === "destructive" || item === "money_moving" || item === "deploy" || item === "secret_access")) {
    return "always_approve";
  }
  return "approve_once";
}

export function classifyMcpToolPolicyClasses(tool: McpPolicyToolLike): McpToolPolicyClass[] {
  const annotations = tool.annotations ?? {};
  const text = `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.replace(/[_:-]+/g, " ");
  const classes = new Set<McpToolPolicyClass>();

  if (annotations.readOnlyHint === true || READ_RE.test(text)) classes.add("read_only");
  if (annotations.destructiveHint === true || DESTRUCTIVE_RE.test(text)) classes.add("destructive");
  if (WRITE_RE.test(text) || annotations.readOnlyHint === false) classes.add("write");
  if (CUSTOMER_FACING_RE.test(text)) classes.add("customer_facing");
  if (MONEY_RE.test(text)) classes.add("money_moving");
  if (DEPLOY_RE.test(text)) classes.add("deploy");
  if (SECRET_RE.test(text)) classes.add("secret_access");

  if (classes.size === 0) classes.add("write");
  if (classes.size > 1 && classes.has("read_only") && [...classes].some((item) => item !== "read_only")) {
    classes.delete("read_only");
  }
  return [...classes];
}

export function mcpToolRiskLabel(classes: McpToolPolicyClass[]): "low" | "medium" | "high" | "critical" {
  if (classes.some((item) => item === "destructive" || item === "secret_access" || item === "money_moving")) return "critical";
  if (classes.some((item) => item === "deploy" || item === "customer_facing")) return "high";
  if (classes.includes("write")) return "medium";
  return "low";
}

export function mcpPolicyClassLabel(policyClass: McpToolPolicyClass): string {
  return policyClass.replace(/_/g, " ");
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
