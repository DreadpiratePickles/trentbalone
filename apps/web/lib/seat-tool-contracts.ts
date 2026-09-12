import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";
import { adapters as defaultAdapters, type ToolAdapter } from "@/lib/tools";
import { AGENT_SLOTS, buildSlotEnvironment } from "@/lib/agent-catalog";
import { INTERNAL_ACTIONS, internalActionCapability } from "@/lib/internal-actions";

export type ToolBinding =
  | "adapter_name"
  | "adapter_scope"
  | "internal_action"
  | "mcp_dynamic"
  | "alias"
  | "unavailable_marker";

export type ToolReadiness =
  | "connected"
  | "needs_credentials"
  | "mocked"
  | "unavailable"
  | "internal";

export type SeatToolContract = {
  seat: AgentRole;
  tool: string;
  binding: ToolBinding | null;
  resolvedAdapter: string | null;
  readiness: ToolReadiness;
  advertised: boolean;
  approvalRequired: boolean;
  writeCapable: boolean;
  notes?: string;
};

export function buildSeatToolContracts(_deps: {
  slotEnvironments: Record<AgentRole, AgentEnvironmentConfig>;
  adapters: ToolAdapter[];
  internalActions: ReadonlySet<string>;
  mcpToolNames: ReadonlySet<string>;
  healthByAdapter: Map<string, ToolReadiness>;
}): SeatToolContract[] {
  const deps = normalizeDeps(_deps);
  const contracts: SeatToolContract[] = [];

  for (const [seat, environment] of Object.entries(deps.slotEnvironments) as Array<[AgentRole, AgentEnvironmentConfig]>) {
    for (const tool of environment.tools) {
      const binding = bindingForTool(tool, deps);
      const adapter = binding.adapter;
      const writeCapable = isWriteCapable(tool, binding.kind, adapter);
      contracts.push({
        seat,
        tool,
        binding: binding.kind,
        resolvedAdapter: adapter?.name ?? null,
        readiness: readinessForBinding(binding.kind, adapter, deps.healthByAdapter),
        advertised: binding.kind !== null,
        approvalRequired: writeCapable ? isApprovalRequired(tool, environment, adapter) : false,
        writeCapable,
        notes: binding.notes,
      });
    }
  }

  return contracts;
}

export function contractsForSeat(all: SeatToolContract[], seat: AgentRole): SeatToolContract[] {
  return all.filter((contract) => contract.seat === seat);
}

export function orphans(_all: SeatToolContract[]): SeatToolContract[] {
  return _all.filter((contract) => contract.binding === null);
}

export function phantoms(all: SeatToolContract[]): SeatToolContract[] {
  return all.filter((contract) => contract.binding !== null && !contract.advertised);
}

export function buildAdvertisedToolSet(contracts: SeatToolContract[], seat: AgentRole): Set<string> {
  return new Set(contractsForSeat(contracts, seat).filter((contract) => contract.advertised).map((contract) => contract.tool));
}

export async function resolveSeatToolContracts(companyId?: string): Promise<SeatToolContract[]> {
  const mcpAdapters = companyId
    ? await import("@/lib/mcp-tool-adapter")
        .then((module) => module.getMcpAdaptersForCompany(companyId))
        .catch(() => [])
    : [];
  const adapters = [...defaultAdapters, ...mcpAdapters];
  const healthByAdapter = new Map<ToolAdapter["name"], ToolReadiness>();
  await Promise.all(adapters.map(async (adapter) => {
    healthByAdapter.set(adapter.name, readinessFromAdapterHealth(adapter, await adapter.healthCheck(companyId)));
  }));
  const mcpToolNames = mcpToolNamesForAdapters(mcpAdapters);
  return buildSeatToolContracts({
    slotEnvironments: slotEnvironmentsWithMcpTools(companyId ?? "company", [...mcpAdapters.map((adapter) => adapter.name)]),
    adapters,
    internalActions: INTERNAL_ACTIONS,
    mcpToolNames,
    healthByAdapter,
  });
}

type NormalizedDeps = {
  slotEnvironments: Record<AgentRole, AgentEnvironmentConfig>;
  adapters: ToolAdapter[];
  internalActions: Set<string>;
  mcpToolNames: Set<string>;
  healthByAdapter: Map<string, ToolReadiness>;
  adapterByName: Map<string, ToolAdapter>;
  adapterByScope: Map<string, ToolAdapter>;
};

function normalizeDeps(deps: {
  slotEnvironments: Record<AgentRole, AgentEnvironmentConfig>;
  adapters: ToolAdapter[];
  internalActions: ReadonlySet<string>;
  mcpToolNames: ReadonlySet<string>;
  healthByAdapter: Map<string, ToolReadiness>;
}): NormalizedDeps {
  const adapterByName = new Map<string, ToolAdapter>();
  const adapterByScope = new Map<string, ToolAdapter>();
  for (const adapter of deps.adapters) {
    adapterByName.set(key(adapter.name), adapter);
    for (const scope of adapter.scopes) {
      if (!adapterByScope.has(key(scope))) adapterByScope.set(key(scope), adapter);
    }
  }
  return {
    ...deps,
    internalActions: lowerSet(deps.internalActions),
    mcpToolNames: lowerSet(deps.mcpToolNames),
    adapterByName,
    adapterByScope,
  };
}

function bindingForTool(tool: string, deps: NormalizedDeps): {
  kind: ToolBinding | null;
  adapter?: ToolAdapter;
  notes?: string;
} {
  const normalized = key(tool);

  if (deps.internalActions.has(normalized)) return { kind: "internal_action" };

  const named = deps.adapterByName.get(normalized);
  if (named) return { kind: "adapter_name", adapter: named };

  const scoped = deps.adapterByScope.get(normalized);
  if (scoped) return { kind: "adapter_scope", adapter: scoped };

  if (deps.mcpToolNames.has(normalized)) {
    return { kind: "mcp_dynamic", notes: "Resolved from the connected MCP tool registry at runtime." };
  }

  if (normalized.endsWith("_unavailable") || normalized.includes("_unavailable:") || normalized.includes(":read_unavailable")) {
    return { kind: "unavailable_marker", notes: "Intentional unavailable marker; no execution without a real provider." };
  }

  return { kind: null, notes: "No adapter, adapter scope, internal action, MCP tool, alias, or unavailable marker matched this string." };
}

function readinessForBinding(
  binding: ToolBinding | null,
  adapter: ToolAdapter | undefined,
  healthByAdapter: Map<string, ToolReadiness>,
): ToolReadiness {
  if (binding === "internal_action") return "internal";
  if (binding === "unavailable_marker" || binding === null) return "unavailable";
  if (binding === "mcp_dynamic") return healthByAdapter.get("mcp_dynamic") ?? "needs_credentials";
  if (!adapter) return "unavailable";
  if (adapter.availability === "unavailable") return "unavailable";
  if (adapter.availability === "test_only") return "mocked";
  return healthByAdapter.get(adapter.name) ?? "needs_credentials";
}

function readinessFromAdapterHealth(
  adapter: ToolAdapter,
  health: "mocked" | "connected" | "needs_credentials",
): ToolReadiness {
  if (adapter.availability === "unavailable") return "unavailable";
  if (adapter.availability === "test_only") return "mocked";
  return health;
}

const MUTATING_TOOL_RE = /\b(send|publish|launch|deploy|charge|refund|payout|merge|delete|issue|branch|pr|sync|trade|broker|external|submit|login|purchase|download|cookie|auth|form|upload|write|create|update|import|generate|render|export|post:create|tweet:publish|social:publish)\b/i;
const SAFE_SCOPE_RE = /\b(read|search|context|graph|scrape|screenshot|pdf|sessions|preview|inspect|lint|render|catalog|metrics|mrr|balance|subscriptions|errors|issues|project|inbound|draft|report|analysis|research)\b/i;
const SAMPLE_MUTATING_ACTIONS = [
  "send",
  "publish",
  "launch",
  "deploy",
  "charge",
  "refund",
  "issue",
  "branch",
  "merge",
  "delete",
  "login",
  "submit",
  "sync live account",
  "trade",
  "upload",
];

function isWriteCapable(tool: string, binding: ToolBinding | null, adapter?: ToolAdapter): boolean {
  if (!binding || binding === "unavailable_marker" || binding === "mcp_dynamic") return false;
  if (binding === "internal_action") return Boolean(internalActionCapability(tool)?.writeCapable);
  if (binding === "adapter_scope") {
    const searchableTool = searchableToolText(tool);
    if (SAFE_SCOPE_RE.test(searchableTool) && !MUTATING_TOOL_RE.test(searchableTool)) return false;
    return MUTATING_TOOL_RE.test(searchableTool);
  }
  return Boolean(adapter && SAMPLE_MUTATING_ACTIONS.some((action) => adapter.requiresApproval(action)));
}

function isApprovalRequired(tool: string, environment: AgentEnvironmentConfig, adapter?: ToolAdapter) {
  const internalCapability = internalActionCapability(tool);
  if (internalCapability?.writeCapable) return internalCapability.approvalRequired;
  if (environment.approvalRequiredFor.some((gate) => gateMatchesTool(gate, tool))) return true;
  return Boolean(adapter && SAMPLE_MUTATING_ACTIONS.some((action) => adapter.requiresApproval(action)));
}

function gateMatchesTool(gate: string, tool: string) {
  const normalizedGate = key(gate).replace(/[._]/g, ":");
  const normalizedTool = key(tool).replace(/[._]/g, ":");
  if (normalizedGate === normalizedTool) return true;
  const [toolProvider] = normalizedTool.split(":");
  const [gateProvider] = normalizedGate.split(":");
  return Boolean(toolProvider && gateProvider && toolProvider === gateProvider);
}

function key(value: string) {
  return value.trim().toLowerCase();
}

function lowerSet(values: ReadonlySet<string>) {
  return new Set([...values].map(key));
}

function searchableToolText(tool: string) {
  return key(tool).replace(/[:._-]+/g, " ");
}

function slotEnvironmentsWithMcpTools(companyId: string, mcpAdapterNames: string[]): Record<AgentRole, AgentEnvironmentConfig> {
  return Object.fromEntries(
    AGENT_SLOTS.map((slot) => {
      const environment = buildSlotEnvironment(companyId, slot.role);
      return [
        slot.role,
        mcpAdapterNames.length
          ? { ...environment, tools: [...environment.tools, ...mcpAdapterNames] }
          : environment,
      ];
    }),
  ) as Record<AgentRole, AgentEnvironmentConfig>;
}

function mcpToolNamesForAdapters(adapters: ToolAdapter[]): Set<string> {
  return new Set(
    adapters
      .filter((adapter) => adapter.name.startsWith("mcp_"))
      .flatMap((adapter) => [adapter.name, ...adapter.scopes])
      .map(key),
  );
}
