import { AGENT_SLOTS, SLOT_CONTRACTS, SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import type { SeatToolContract, ToolReadiness } from "@/lib/seat-tool-contracts";
import type { AgentRole, WorkbenchAgentMode } from "@/lib/types";

export type WorkbenchAgentToolStatus = "real" | "unavailable" | "test_only";

export type WorkbenchAgentTool = {
  name: string;
  status: WorkbenchAgentToolStatus;
  readiness: ToolReadiness;
  approvalRequired: boolean;
  writeCapable: boolean;
  reason?: string;
};

export type WorkbenchAgent = {
  role: AgentRole;
  label: string;
  defaultName: string;
  mission: string;
  skills: string[];
  tools: WorkbenchAgentTool[];
  deliverables: string[];
  approvalGates: string[];
  mode: WorkbenchAgentMode;
};

const MODE_BY_ROLE: Record<AgentRole, WorkbenchAgentMode> = {
  ceo: "research",
  engineer: "build",
  growth: "design",
  content: "design",
  support: "research",
  analyst: "research",
  finance: "research",
  escalation: "research",
  sales: "research",
};

const APP_LABEL_TOOLS = new Set([
  "Steel Browser",
  "HyperFrames",
  "Open Generative AI",
  // Legacy fake finance app labels can still exist in old contract snapshots.
  // They are intentionally hidden until backed by real templates/providers.
  "Fincept Terminal",
  "Ghostfolio",
]);

export function getWorkbenchAgents(): WorkbenchAgent[] {
  return buildWorkbenchAgentsFromContracts(fallbackWorkbenchAgentContracts());
}

export function buildWorkbenchAgentsFromContracts(contracts: SeatToolContract[]): WorkbenchAgent[] {
  return AGENT_SLOTS.map((slot) => {
    const contract = SLOT_CONTRACTS[slot.role];
    const environment = SLOT_ENVIRONMENTS[slot.role];
    const tools = contracts
      .filter((toolContract) => toolContract.seat === slot.role)
      .filter((toolContract) => toolContract.advertised)
      .filter((toolContract) => !APP_LABEL_TOOLS.has(toolContract.tool))
      .map((toolContract) => toolFromContract(toolContract));

    return {
      role: slot.role,
      label: slot.label,
      defaultName: slot.defaultName,
      mission: contract.mission,
      skills: environment.skills ?? [],
      tools: uniqueTools(tools),
      deliverables: contract.deliverables,
      approvalGates: environment.approvalRequiredFor,
      mode: MODE_BY_ROLE[slot.role],
    };
  });
}

export function buildWorkbenchAgentObjective(agent: WorkbenchAgent, objective: string): string {
  const cleanObjective = objective.trim() || `Run a focused ${agent.label} Workbench session.`;
  return [
    `[workbench-agent] ${agent.label}`,
    `Mission: ${agent.mission}`,
    `Objective: ${cleanObjective}`,
    `Agent communication contract: stay in the ${agent.label} seat, use Workbench evidence and allowed tools only, and report blockers as handoff-ready notes.`,
    `Tools declared: ${formatToolsForPrompt(agent.tools)}`,
    `Deliverables: ${agent.deliverables.join(", ")}`,
    `Approval gates: ${agent.approvalGates.join(", ") || "none"}`,
    "Evidence required: cite files, commands, test output, screenshots, source documents, approvals, and verification artifacts when relevant.",
    "Unavailable tools are visible for planning only. Do not claim you used a tool unless a completed tool event, artifact, or command proves it.",
    "Call out not-done work, assumptions, data caveats, and approval requests explicitly.",
  ].join("\n");
}

export function summarizeWorkbenchAgentTools(agent: WorkbenchAgent): string[] {
  return agent.tools.map((tool) => {
    const flags = [
      tool.status,
      tool.readiness,
      tool.approvalRequired ? "approval-required" : null,
      tool.writeCapable ? "write-capable" : null,
    ].filter(Boolean);
    return `${tool.name} [${flags.join("; ")}]`;
  });
}

function fallbackWorkbenchAgentContracts(): SeatToolContract[] {
  return AGENT_SLOTS.flatMap((slot) => {
    const environment = SLOT_ENVIRONMENTS[slot.role];
    return unique(environment.tools).map((tool) => ({
      seat: slot.role,
      tool,
      binding: null,
      resolvedAdapter: null,
      readiness: "unavailable" as const,
      advertised: true,
      approvalRequired: false,
      writeCapable: false,
      notes: "Server tool contract not loaded.",
    }));
  });
}

function toolFromContract(contract: SeatToolContract): WorkbenchAgentTool {
  const status = statusFromReadiness(contract.readiness);
  return {
    name: contract.tool,
    status,
    readiness: contract.readiness,
    approvalRequired: contract.approvalRequired,
    writeCapable: contract.writeCapable,
    reason: reasonForContract(contract, status),
  };
}

function statusFromReadiness(readiness: ToolReadiness): WorkbenchAgentToolStatus {
  if (readiness === "mocked") return "test_only";
  if (readiness === "connected" || readiness === "internal") return "real";
  return "unavailable";
}

function reasonForContract(contract: SeatToolContract, status: WorkbenchAgentToolStatus): string | undefined {
  if (contract.notes) return contract.notes;
  if (status === "test_only") return "test/dev-only placeholder";
  if (contract.readiness === "needs_credentials") return "needs provider credentials";
  if (contract.binding === null) return "tool adapter not configured";
  if (contract.readiness === "unavailable") return "provider integration not configured";
  return undefined;
}

function formatToolsForPrompt(tools: WorkbenchAgentTool[]): string {
  if (!tools.length) return "none";
  return tools.map((tool) => {
    const flags = [
      tool.status,
      `readiness=${tool.readiness}`,
      tool.approvalRequired ? "approval-required" : null,
      tool.writeCapable ? "write-capable" : null,
      tool.reason ?? null,
    ].filter(Boolean);
    return `${tool.name} (${flags.join("; ")})`;
  }).join(", ");
}

function uniqueTools(items: WorkbenchAgentTool[]): WorkbenchAgentTool[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}
