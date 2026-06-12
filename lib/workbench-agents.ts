import { AGENT_SLOTS, SLOT_CONTRACTS, SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import type { AgentRole, WorkbenchAgentMode } from "@/lib/types";

export type WorkbenchAgentToolStatus = "real" | "unavailable" | "test_only";

export type WorkbenchAgentTool = {
  name: string;
  status: WorkbenchAgentToolStatus;
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
  "Fincept Terminal",
  "Ghostfolio",
]);

const REAL_TOOL_PREFIXES = [
  "approvals:",
  "audit:",
  "documents:",
  "github:",
  "memory:",
  "reports:",
  "tasks:",
  "usage:",
  "vault:",
  "gitnexus:",
];

const UNCONFIGURED_PROVIDER_PREFIXES = [
  "steel:",
  "hyperframes:",
  "open_gen_ai:",
  "fincept:",
  "ghostfolio:",
];

export function getWorkbenchAgents(): WorkbenchAgent[] {
  return AGENT_SLOTS.map((slot) => {
    const contract = SLOT_CONTRACTS[slot.role];
    const environment = SLOT_ENVIRONMENTS[slot.role];
    return {
      role: slot.role,
      label: slot.label,
      defaultName: slot.defaultName,
      mission: contract.mission,
      skills: environment.skills ?? [],
      tools: unique(environment.tools)
        .filter((tool) => !APP_LABEL_TOOLS.has(tool))
        .map((tool) => classifyWorkbenchAgentTool(tool)),
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
  return agent.tools.map((tool) => `${tool.name} [${tool.status}]`);
}

function classifyWorkbenchAgentTool(name: string): WorkbenchAgentTool {
  if (name.includes("_mock") || name.endsWith(":mock") || name.includes(":mock_") || name === "tests:mock") {
    return { name, status: "test_only", reason: "test/dev-only placeholder" };
  }
  if (UNCONFIGURED_PROVIDER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { name, status: "unavailable", reason: "provider integration not configured" };
  }
  if (REAL_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return { name, status: "real" };
  }
  return { name, status: "unavailable", reason: "tool adapter not configured" };
}

function formatToolsForPrompt(tools: WorkbenchAgentTool[]): string {
  if (!tools.length) return "none";
  return tools.map((tool) => {
    const reason = tool.reason ? `; ${tool.reason}` : "";
    return `${tool.name} (${tool.status}${reason})`;
  }).join(", ");
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}
