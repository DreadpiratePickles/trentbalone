/** Hermes's skills_list / skill_view / skill_manage schemas, as data for the seat prompt. */
import type { ToolSchema } from "../web/schemas.js";

export const SKILLS_LIST_BUDGET = 6_000;
export const SKILL_DESCRIPTION_CLIP = 60;

export const SKILL_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "skills_list",
    description:
      "List installed skills: name, category, trust tier and a short description. Use skill_view " +
      "to read one in full.",
    parameters: {
      type: "object",
      properties: { category: { type: "string", description: "Only skills in this category." } },
    },
  },
  {
    name: "skill_view",
    description:
      "Read a skill's full instructions plus a listing of its bundled references/, scripts/ and " +
      "assets/. Pass file_path to read one bundled file.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        file_path: { type: "string", description: "e.g. scripts/run.sh - only inside the bundle dirs." },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_manage",
    description:
      "Create, patch or delete skills you author, and manage their bundled files. Every write is " +
      "security-scanned; a dangerous verdict is refused and cannot be forced. Builtin and official " +
      "skills are read-only.",
    parameters: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["create", "patch", "delete", "write_file", "remove_file"] },
              name: { type: "string", description: "Skill name: lowercase letters, digits, - and _." },
              category: { type: "string", description: "create: category folder (default general)." },
              description: { type: "string", description: "create: one-line description." },
              content: { type: "string", description: "create: SKILL.md body; write_file: file contents." },
              old_string: { type: "string", description: "patch: exact text to replace in SKILL.md." },
              new_string: { type: "string", description: "patch: replacement text." },
              file_path: { type: "string", description: "write_file/remove_file: path under references/, scripts/ or assets/." },
            },
            required: ["action", "name"],
          },
        },
      },
      required: ["operations"],
    },
  },
];
