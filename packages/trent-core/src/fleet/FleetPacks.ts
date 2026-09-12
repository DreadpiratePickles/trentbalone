export interface FleetPack {
  id: string;
  name: string;
  description: string;
  agents: string[];
}

export const FLEET_PACKS: Record<string, FleetPack> = {
  engineering: {
    id: "engineering",
    name: "Engineering Pack",
    description: "Full-stack software delivery team: AI engineer, frontend, backend, devops, and QA.",
    agents: [
      "eng-ai-engineer",
      "eng-frontend-developer",
      "eng-backend-architect",
      "eng-devops-automator",
      "spec-model-qa",
    ],
  },
  marketing: {
    id: "marketing",
    name: "Marketing & Growth Pack",
    description: "Acquisition and narrative engine: growth hacker, search optimizer, citation strategist.",
    agents: [
      "growth",
      "content",
      "mkt-agentic-search-optimizer",
      "mkt-ai-citation-strategist",
    ],
  },
  finance: {
    id: "finance",
    name: "Finance & Treasury Pack",
    description: "Financial controls, bookkeeping, FP&A modeling, and tax strategy.",
    agents: [
      "finance",
      "fin-bookkeeper-controller",
      "fin-financial-analyst",
      "fin-fpa-analyst",
      "fin-tax-strategist",
    ],
  },
  support: {
    id: "support",
    name: "Customer Support & Success Pack",
    description: "24/7 omni-channel support, escalations, and analytics reporting.",
    agents: [
      "support",
      "sup-support-responder",
      "sup-analytics-reporter",
      "sup-executive-summary-generator",
    ],
  },
  executive: {
    id: "executive",
    name: "Executive Leadership Pack",
    description: "Strategic decision-making team: CEO, Lead Engineer, Growth Hacker, and Finance Lead.",
    agents: [
      "ceo",
      "engineer",
      "growth",
      "finance",
    ],
  },
  "eng-trio": {
    id: "eng-trio",
    name: "Engineering Trio",
    description: "Core software engineering squad: AI Engineer, Backend Architect, DevOps.",
    agents: ["engineer", "eng-ai-engineer", "eng-backend-architect"],
  },
  "growth-engine": {
    id: "growth-engine",
    name: "Growth Engine",
    description: "High-leverage growth & distribution squad.",
    agents: ["growth", "content", "mkt-agentic-search-optimizer"],
  },
  revops: {
    id: "revops",
    name: "Revenue Operations Pack",
    description: "Finance and customer success alignment team.",
    agents: ["finance", "support", "fin-bookkeeper-controller"],
  },
  "security-audit": {
    id: "security-audit",
    name: "Security & Compliance Pack",
    description: "Code audit, dependency scan, and risk assessment.",
    agents: ["escalation", "eng-ai-engineer"],
  },
  all: {
    id: "all",
    name: "Full 164-Specialist Fleet",
    description: "Deploy the complete cofounder fleet across all categories.",
    agents: ["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "browser", "escalation"],
  },
};

export function resolveFleetPack(packId: string): FleetPack | undefined {
  const norm = packId.toLowerCase().trim();
  if (FLEET_PACKS[norm]) return FLEET_PACKS[norm];
  if (norm.includes("eng")) return FLEET_PACKS["engineering"] || FLEET_PACKS["eng-trio"];
  if (norm.includes("growth") || norm.includes("market")) return FLEET_PACKS["marketing"] || FLEET_PACKS["growth-engine"];
  if (norm.includes("fin")) return FLEET_PACKS["finance"];
  if (norm.includes("supp")) return FLEET_PACKS["support"];
  if (norm.includes("exec")) return FLEET_PACKS["executive"];
  return undefined;
}
