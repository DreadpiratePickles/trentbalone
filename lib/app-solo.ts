import { AGENT_SLOTS, SLOT_CONTRACTS, SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import type { AgentRole, WorkbenchAgentMode } from "@/lib/types";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent";

export type AppSoloApp = {
  id: string;
  name: string;
  label: string;
  description: string;
  scopes: string[];
  accent: "pulse" | "ember" | "bone";
};

export type AppSoloAgent = {
  role: AgentRole;
  label: string;
  defaultName: string;
  mission: string;
  skills: string[];
  tools: string[];
  apps: AppSoloApp[];
  deliverables: string[];
  approvalGates: string[];
  mode: WorkbenchAgentMode;
};

const APP_DEFINITIONS: Record<string, Omit<AppSoloApp, "scopes">> = {
  "Steel Browser": {
    id: "steel-browser",
    name: "Steel Browser",
    label: "Web",
    description: "Research public pages, capture screenshots and PDFs, and scrape approved web evidence.",
    accent: "pulse",
  },
  HyperFrames: {
    id: "hyperframes",
    name: "HyperFrames",
    label: "Video",
    description: "Plan and render HTML-first launch videos and motion creative.",
    accent: "ember",
  },
  "Open Generative AI": {
    id: "open-generative-ai",
    name: "Open Generative AI",
    label: "Creative",
    description: "Sandbox image, video, lip-sync, and cinema workflows for growth creative.",
    accent: "pulse",
  },
  "Fincept Terminal": {
    id: "fincept-terminal",
    name: "Fincept Terminal",
    label: "Finance",
    description: "Sandbox market research, portfolio analysis, risk reports, and paper trading.",
    accent: "bone",
  },
  Ghostfolio: {
    id: "ghostfolio",
    name: "Ghostfolio",
    label: "Wealth",
    description: "Sandbox portfolio composition, holdings import, performance, risk, and FIRE planning.",
    accent: "pulse",
  },
};

const APP_TOOL_PREFIXES: Record<string, string[]> = {
  "Steel Browser": ["steel:"],
  HyperFrames: ["hyperframes:"],
  "Open Generative AI": ["open_gen_ai:"],
  "Fincept Terminal": ["fincept:"],
  Ghostfolio: ["ghostfolio:"],
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

export function getAppSoloAgents(): AppSoloAgent[] {
  return AGENT_SLOTS.map((slot) => {
    const contract = SLOT_CONTRACTS[slot.role];
    const environment = SLOT_ENVIRONMENTS[slot.role];
    return {
      role: slot.role,
      label: slot.label,
      defaultName: slot.defaultName,
      mission: contract.mission,
      skills: environment.skills ?? [],
      tools: environment.tools,
      apps: appsFromTools(environment.tools),
      deliverables: contract.deliverables,
      approvalGates: environment.approvalRequiredFor,
      mode: MODE_BY_ROLE[slot.role],
    };
  });
}

export function buildAppSoloObjective(agent: AppSoloAgent, app: AppSoloApp, objective: string): string {
  const cleanObjective = objective.trim() || `Run a focused ${agent.label} sandbox session.`;
  return [
    `[app-solo] ${agent.label} / ${app.name}`,
    `Mission: ${agent.mission}`,
    `Sandbox app: ${app.name}`,
    `Objective: ${cleanObjective}`,
    `Agent communication contract: stay in the ${agent.label} seat, use only the ${app.name} sandbox context unless explicitly routed, and report blockers as handoff-ready notes.`,
    `App scopes: ${app.scopes.join(", ") || "none declared"}`,
    `Deliverables: ${agent.deliverables.join(", ")}`,
    `Approval gates: ${agent.approvalGates.join(", ") || "none"}`,
    "Verification required: include concrete evidence, artifact references, preview/test status where applicable, and next actions.",
    "Call out not-done work, assumptions, data caveats, and approval requests explicitly.",
  ].join("\n");
}

/**
 * Render a streamed agent chunk as a one-line human-readable trace entry.
 * Returns null for chunks that should not appear in the trace (raw prose tokens).
 * Pure + exported so the App Solo run loop's progress feed is unit-testable.
 */
export function describeChunk(chunk: WorkbenchAgentChunk): string | null {
  switch (chunk.type) {
    case "status":  return chunk.detail ? `${chunk.phase}: ${chunk.detail}` : chunk.phase;
    case "plan":    return `plan ready — ${chunk.steps.length} step${chunk.steps.length === 1 ? "" : "s"}`;
    case "file":    return `${chunk.action} ${chunk.path} (${chunk.bytes}b)`;
    case "command": return `$ ${chunk.command} → exit ${chunk.exitCode}`;
    case "test":    return `tests: ${chunk.passed} passed, ${chunk.failed} failed${chunk.healed ? " (healed)" : ""}`;
    case "verify":  return `verify ${chunk.passed ? "passed" : "failed"} — ${chunk.checks.map((c) => `${c.name}:${c.status}`).join(", ")}`;
    case "preview": return `preview ready: ${chunk.url}`;
    case "error":   return `error: ${chunk.message}`;
    case "done":    return "run complete";
    case "content": return null; // streamed prose — shown elsewhere, not in the trace
    default:        return null;
  }
}

function appsFromTools(tools: string[]): AppSoloApp[] {
  return Object.entries(APP_DEFINITIONS)
    .filter(([name]) => tools.includes(name))
    .map(([name, app]) => ({
      ...app,
      scopes: tools.filter((tool) => APP_TOOL_PREFIXES[name].some((prefix) => tool.startsWith(prefix))),
    }));
}
