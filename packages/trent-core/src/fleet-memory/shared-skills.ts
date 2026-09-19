/**
 * Requirement 4: every seat sees the org skill tier plus its own live skills. The org tier is the
 * `__org__` pseudo-agent's live drafts (`../improve/org-tier.ts`); a consumer copy the gate
 * distributed to this seat carries the same content hash and is folded into the org entry, so a
 * skill never appears twice. Read-only: promotion stays with the improve loop and a human.
 */

import { ORG_TIER_AGENT } from "../improve/org-tier.js";
import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";

export type SharedSkillTier = "org" | "own";

export interface SharedSkill {
  readonly id: string;
  readonly agentId: string;
  readonly taskType: string;
  readonly tier: SharedSkillTier;
  readonly content: string;
}

function firstHeading(content: string): string {
  const line = content.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : "";
}

/** Org-tier live skills first (by task type), then this seat's own; consumer copies of an org skill are folded. */
export async function listSharedSkills(store: ImproveStorePort, companyId: string, agentId: string): Promise<SharedSkill[]> {
  const byTask = (a: SkillDraftRow, b: SkillDraftRow) => a.taskType.localeCompare(b.taskType) || a.id.localeCompare(b.id);
  const org = (await store.listDrafts(companyId, { agentId: ORG_TIER_AGENT, kind: "skill", status: "live" })).sort(byTask);
  const own = agentId === ORG_TIER_AGENT ? [] : (await store.listDrafts(companyId, { agentId, kind: "skill", status: "live" })).sort(byTask);
  const orgHashes = new Set(org.map((d) => d.contentHash));
  const out: SharedSkill[] = org.map((d) => ({ id: d.id, agentId: d.agentId, taskType: d.taskType, tier: "org", content: d.content }));
  for (const d of own) {
    if (orgHashes.has(d.contentHash)) continue;
    out.push({ id: d.id, agentId: d.agentId, taskType: d.taskType, tier: "own", content: d.content });
  }
  return out;
}

export const SHARED_SKILLS_HEADING = '## Shared skills (fleet_skill_view {"skill": "<task type>"} for the body)';

/**
 * One line per skill; the body is fetched on demand with `fleet_skill_view`.
 *
 * `heading` exists because the index is rendered TWICE into one prompt: the org tier is the same
 * bytes for every seat and rides the stable tier, while a seat's own skills are seat-scoped and
 * ride the context tier. Two identical headings in one prompt would read as a duplication bug.
 */
export function renderSharedSkillsIndex(skills: readonly SharedSkill[], heading: string = SHARED_SKILLS_HEADING): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const title = firstHeading(s.content);
    return `- ${s.taskType} [${s.tier}]${title ? `: ${title}` : ""}`;
  });
  return `${heading}\n${lines.join("\n")}`;
}

/** Resolve `skill` as a task type or an id among the skills this seat may see. */
export function findSharedSkill(skills: readonly SharedSkill[], key: string): SharedSkill | undefined {
  const wanted = key.trim().toLowerCase();
  return skills.find((s) => s.id.toLowerCase() === wanted) ?? skills.find((s) => s.taskType.toLowerCase() === wanted);
}
