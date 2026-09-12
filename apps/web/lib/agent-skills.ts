import skillMap from "@/lib/data/skill-agent-map.json";
import type { CatalogAgent, CatalogCategory } from "@/lib/agent-catalog";

type SkillAgentMap = {
  availableSkills: string[];
  categoryDefaults: Record<CatalogCategory, string[]>;
  overrides: Record<string, string[]>;
};

const map = skillMap as SkillAgentMap;
const availableSkills = new Set(map.availableSkills);

function uniqueStable(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function resolveSkillsForAgent(agent: Pick<CatalogAgent, "id" | "category">): string[] {
  return uniqueStable([
    ...(map.categoryDefaults[agent.category] ?? []),
    ...(map.overrides[agent.id] ?? []),
  ]);
}

export function assertSkillsInstalled(skills: string[]): void {
  const unknown = uniqueStable(skills).filter((skill) => !availableSkills.has(skill));
  if (unknown.length > 0) {
    throw new Error(`Unknown Agent Plug skill(s): ${unknown.join(", ")}`);
  }
}

export function agentSkillMapAvailableSkills(): string[] {
  return [...map.availableSkills];
}
