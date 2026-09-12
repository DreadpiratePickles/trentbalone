import fs from "node:fs/promises";
import path from "node:path";
import { assertSkillsInstalled } from "@/lib/agent-skills";
import type { SkillDraftStore } from "@/lib/skill-foundry";
import { listCustomSkills } from "@/lib/custom-skill-store";

function uniqueStable(values: string[]): string[] {
  return Array.from(new Set(values));
}

export async function listInstalledSkillNames(skillRoot = ".claude/skills"): Promise<string[]> {
  const root = path.resolve(process.cwd(), skillRoot);
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function loadGrantedSkillInstructions(
  skills: string[],
  skillRoot = ".claude/skills"
): Promise<string[]> {
  assertSkillsInstalled(skills);
  const root = path.resolve(process.cwd(), skillRoot);

  const blocks: string[] = [];
  for (const skill of uniqueStable(skills)) {
    const skillPath = path.join(root, skill, "SKILL.md");
    const raw = await fs.readFile(skillPath, "utf8");
    blocks.push([`Skill: ${skill}`, stripFrontmatter(raw).trim()].join("\n"));
  }
  return blocks;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  return end === -1 ? raw : raw.slice(end + 4);
}

/**
 * Relevance score for a company skill against a requested task type.
 * Exact match = 1.0; partial overlap = 0.5; no relation = 0.0.
 */
function taskTypeRelevance(skillTaskType: string, requested: string): number {
  if (skillTaskType === requested) return 1.0;
  const a = skillTaskType.toLowerCase();
  const b = requested.toLowerCase();
  if (a.includes(b) || b.includes(a)) return 0.5;
  // token-level overlap
  const aToks = new Set(a.split(/[_\s-]+/));
  const bToks = b.split(/[_\s-]+/);
  const shared = bToks.filter((t) => aToks.has(t)).length;
  return shared > 0 ? 0.25 : 0.0;
}

export type CompanySkillBlock = {
  taskType: string;
  content: string;
  /** 0..1 task-type relevance score used for ranking. */
  relevance: number;
};

/**
 * Load live, agent-written skills for a company from the draft store.
 * Skills are ranked by task-type relevance (exact > partial > no match).
 * When `taskType` is omitted, all live skills are returned ordered by taskType.
 * At most `maxSkills` blocks are returned (default 5).
 *
 * Each returned block is formatted as "Skill: <taskType>\n<content>" — the
 * same progressive-disclosure shape used by loadGrantedSkillInstructions.
 */
export async function loadCompanySkillInstructions(
  companyId: string,
  store: SkillDraftStore,
  options?: { taskType?: string; maxSkills?: number },
): Promise<string[]> {
  const maxSkills = options?.maxSkills ?? 5;
  const taskType = options?.taskType;

  const allTaskTypes = await store.listLiveTaskTypes(companyId);
  const contents = await Promise.all(
    allTaskTypes.map(async (tt): Promise<CompanySkillBlock> => ({
      taskType: tt,
      content: (await store.readLive(companyId, tt)) ?? "",
      relevance: taskType ? taskTypeRelevance(tt, taskType) : 0,
    })),
  );

  const ranked = contents
    .filter((b) => b.content.length > 0)
    .sort((a, b) =>
      taskType
        ? b.relevance - a.relevance || a.taskType.localeCompare(b.taskType)
        : a.taskType.localeCompare(b.taskType),
    )
    .slice(0, maxSkills);

  return ranked.map((b) => [`Skill (company): ${b.taskType}`, stripFrontmatter(b.content).trim()].join("\n"));
}

/**
 * Build a system-prompt prelude from a company's live skills, most relevant to
 * the step first. This is the reuse mechanism that makes the self-improvement
 * loop pay off (OpenSpace "skill reuse" → token savings): agents follow a proven
 * procedure instead of re-deriving it.
 *
 * Returns `{ prelude: "", applied: false }` when the company has no live skill,
 * so callers can prepend unconditionally with no effect in the empty case.
 * `applied` is the signal recorded on the trace (TraceRecord.skillApplied) to
 * compute the OpenSpace applied rate.
 */
export async function buildCompanySkillPrelude(
  companyId: string,
  store: SkillDraftStore,
  stepText: string,
  maxSkills = 2,
): Promise<{ prelude: string; applied: boolean }> {
  const blocks = await loadCompanySkillInstructions(companyId, store, {
    taskType: stepText,
    maxSkills,
  });
  if (blocks.length === 0) return { prelude: "", applied: false };
  return {
    prelude: [
      "# Reusable skills for this task — follow these proven procedures instead of re-deriving:",
      ...blocks,
    ].join("\n\n"),
    applied: true,
  };
}

/**
 * §3.2 — client-authored skills (Settings → Custom Skills). Always-on prelude
 * built from `CompanyCustomSkill` rows: enabled skills are filtered by an
 * optional `trigger` (substring match against the step text); skills with no
 * trigger always apply. Best-effort: a DB error or empty list returns the
 * neutral `{ prelude: "", applied: false }` so callers can prepend it
 * unconditionally with no effect.
 */
export async function buildCustomSkillPrelude(
  companyId: string,
  stepText: string,
): Promise<{ prelude: string; applied: boolean }> {
  if (!process.env.DATABASE_URL) return { prelude: "", applied: false };
  const skills = await listCustomSkills(companyId).catch(() => []);
  const stepLower = (stepText ?? "").toLowerCase();
  const matched = skills.filter((skill) => {
    if (!skill.enabled) return false;
    const trigger = skill.trigger?.trim();
    if (!trigger) return true;
    return stepLower.includes(trigger.toLowerCase());
  });
  if (matched.length === 0) return { prelude: "", applied: false };
  const blocks = matched.map((skill) =>
    [`Custom skill: ${skill.name}`, skill.instructions.trim()].join("\n"),
  );
  return {
    prelude: [
      "# Client-authored skills for this task — follow these procedures exactly:",
      ...blocks,
    ].join("\n\n"),
    applied: true,
  };
}
