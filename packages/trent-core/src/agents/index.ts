/**
 * `@trent/core` wrapper over `apps/web/lib/agent-catalog.ts`.
 *
 * The 164-specialist catalog across 13 divisions, plus category labels/colors
 * and the profile lookup. The app module runs `assertSkillsInstalled` at import
 * time, so importing this wrapper also validates that every skill referenced by
 * the catalog exists in `lib/data/skill-agent-map.json` — a deliberate fail-fast.
 *
 * Types are declared locally: the app's `CatalogAgent` reaches into
 * `@/lib/types` and `@/lib/plug-evals`, and re-exporting it would drag the web
 * type graph into every consumer's `tsc` run (Stage 00 audit).
 *
 * Wraps: apps/web/lib/agent-catalog.ts
 */

import {
  AGENT_CATALOG as LIB_AGENT_CATALOG,
  CATEGORY_COLORS as LIB_CATEGORY_COLORS,
  CATEGORY_LABELS as LIB_CATEGORY_LABELS,
  getCatalogAgent as libGetCatalogAgent,
  getCatalogAgentV3 as libGetCatalogAgentV3,
} from "@/lib/agent-catalog";

export type CatalogCategory =
  | "engineering"
  | "design"
  | "paid-media"
  | "sales"
  | "marketing"
  | "product"
  | "project-management"
  | "testing"
  | "support"
  | "finance"
  | "spatial-computing"
  | "academic"
  | "specialized";

/** Mirrors `AgentQualityLabel` in apps/web/lib/types.ts. */
export type AgentQualityLabel = "experimental" | "supervised" | "autonomous";

export type CatalogAgentTool = {
  name: string;
  purpose: string;
  composio?: { toolkit: string; action: string } | null;
};

export type CatalogAgent = {
  id: string;
  name: string;
  emoji: string;
  category: CatalogCategory;
  specialties: string;
  whenToUse: string;
  whenNotToUse?: string;
  modelPolicy?: "reasoning-heavy" | "balanced" | "fast";
  specialistPrompt?: string;
  designedTools?: CatalogAgentTool[];
  reversibilityMatrix?: {
    reversible: string[];
    costlyToReverse: string[];
    irreversible: string[];
  };
  memoryPlan?: {
    readsOnStart: string[];
    writesOnFinish: string[];
  };
  /** v3: skills this agent should run with, resolved from skill-agent-map.json. */
  skills?: string[];
  capability?: {
    score: number | null;
    qualityLabel: AgentQualityLabel;
  };
  /** Accent color (hex or CSS color) from the product's design tokens. */
  color: string;
  /** Relative path in the agency-agents source repo. */
  file: string;
};

/** All 164 specialists. */
export const AGENT_CATALOG: readonly CatalogAgent[] =
  LIB_AGENT_CATALOG as unknown as readonly CatalogAgent[];

/** Display label for each of the 13 divisions. */
export const CATEGORY_LABELS: Readonly<Record<CatalogCategory, string>> =
  LIB_CATEGORY_LABELS as unknown as Readonly<Record<CatalogCategory, string>>;

/** Accent color for each of the 13 divisions. */
export const CATEGORY_COLORS: Readonly<Record<CatalogCategory, string>> =
  LIB_CATEGORY_COLORS as unknown as Readonly<Record<CatalogCategory, string>>;

/** Look a specialist up by profile id; undefined when unknown. */
export function getCatalogAgent(profileId: string | null | undefined): CatalogAgent | undefined {
  return libGetCatalogAgent(profileId) as CatalogAgent | undefined;
}

/** The v3 view of a specialist, with flagship prompt/tool overrides applied. */
export function getCatalogAgentV3(profileId: string | null | undefined): CatalogAgent | undefined {
  return libGetCatalogAgentV3(profileId) as CatalogAgent | undefined;
}

/** The catalog grouped by division, in catalog order. */
export function agentsByCategory(): Record<CatalogCategory, CatalogAgent[]> {
  const grouped = {} as Record<CatalogCategory, CatalogAgent[]>;
  for (const agent of AGENT_CATALOG) {
    (grouped[agent.category] ??= []).push(agent);
  }
  return grouped;
}

/** Every division present in the catalog, in first-appearance order. */
export function agentCategories(): CatalogCategory[] {
  return [...new Set(AGENT_CATALOG.map((agent) => agent.category))];
}
