/**
 * [S3] Skills on demand in solo (item 3; council A7, Hermes's three-level load).
 *
 * The model can only ask for a skill it knows exists, so the frozen prefix carries an INDEX: one line
 * per advertised skill in the profile's store, its name and a one-line description, never a body
 * (the stable tier, frozen with the rest of the prefix for the conversation). `skill_view` is an
 * ordinary tool call; when it loads a skill (the skill itself, not one of its bundled files) the
 * runner adds the name to the conversation's invoked set, saved with the session, and every later
 * turn's CONTEXT tier carries those bodies, read from the store at that turn. The body therefore
 * outlives the tool result that first showed it: a compaction that drops that result, a restart.
 */
import { clip } from "./events.js";
import type { ContextBlock } from "../fleet-memory/tiers.js";
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import { findSkill, isAdvertised, listSkills, readBody } from "../tools/skills/store.js";
import { SKILLS_ADAPTER_NAME } from "../tools/skills/index.js";
import type { ToolCallRecord } from "../tools/types.js";

export const SKILLS_INDEX_BLOCK = "skills-index";
export const INVOKED_SKILLS_BLOCK = "invoked-skills";

/** One line of the index, at most. */
const DESCRIPTION_CHARS = 100;
/** Past this the index says how many more there are and `skills_list` pages them. */
const INDEX_MAX_SKILLS = 60;

/** The skills a conversation can load. `profileSoloSkills` is the profile's store. */
export interface SoloSkills {
  /** `- <name>: <one line>` per advertised skill, oldest name first; empty when there are none. */
  index(): string;
  /** A skill's body as `skill_view` shows it, or undefined when it is not installed (any longer). */
  body(name: string): string | undefined;
}

export function profileSoloSkills(skillsDir: string): SoloSkills {
  return {
    index() {
      const skills = listSkills(skillsDir).filter(isAdvertised);
      const lines = skills.slice(0, INDEX_MAX_SKILLS).map((skill) => `- ${skill.name}: ${clip(skill.description || "(no description)", DESCRIPTION_CHARS)}`);
      if (skills.length > INDEX_MAX_SKILLS) lines.push(`- ... and ${String(skills.length - INDEX_MAX_SKILLS)} more: skills_list pages them.`);
      return lines.join("\n");
    },
    body(name) {
      const skill = findSkill(skillsDir, name);
      if (skill === null || !isAdvertised(skill)) return undefined;
      return `# ${skill.name}\n${readBody(skill).trim()}`;
    },
  };
}

function argsOf(action: string): Record<string, unknown> {
  const brace = action.indexOf("{");
  if (brace === -1) return {};
  try {
    const parsed: unknown = JSON.parse(action.slice(brace));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The skill a completed `skill_view` loaded; undefined for a bundled file, a failure or any other call. */
export function invokedSkillOf(record: ToolCallRecord | undefined): string | undefined {
  if (record === undefined || record.adapter !== SKILLS_ADAPTER_NAME || record.status !== "completed") return undefined;
  if (toolNameOf(record.action) !== "skill_view") return undefined;
  const args = argsOf(record.action);
  if (typeof args.file_path === "string" && args.file_path.trim() !== "") return undefined;
  return typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;
}

/** The stable block: the index, and how to load one in the one call format the prompt teaches. */
export function skillsIndexBlock(skills: SoloSkills | undefined): ContextBlock | undefined {
  const index = skills?.index() ?? "";
  if (index === "") return undefined;
  const text = [
    "## Skills",
    'Load one before you follow it: {"name": "skill_view", "arguments": {"name": "<skill>"}}. Its full text then stays in your context for the rest of this conversation.',
    index,
  ].join("\n");
  return { tier: "stable", name: SKILLS_INDEX_BLOCK, text };
}

/** The context block: every body this conversation loaded, as the store holds it now. */
export function invokedSkillsBlock(skills: SoloSkills | undefined, names: readonly string[]): ContextBlock | undefined {
  if (skills === undefined || names.length === 0) return undefined;
  const bodies = names.map((name) => skills.body(name) ?? `# ${name}\n(loaded earlier in this conversation; no longer installed)`);
  return { tier: "context", name: INVOKED_SKILLS_BLOCK, text: `## Skills loaded in this conversation\n\n${bodies.join("\n\n")}` };
}
