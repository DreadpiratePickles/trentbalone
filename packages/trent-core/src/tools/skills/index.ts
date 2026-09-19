/**
 * The `skills` toolset: `skills_list`, `skill_view`, `skill_manage` over the committed
 * SkillLoader / SkillsHub store, with Hermes's progressive disclosure: the list is names and
 * clipped descriptions, the view is one skill's body plus a LISTING of its bundle, and a bundled
 * file is returned only when named explicitly.
 *
 * Every write goes through the committed SecurityScan inside `execute`; a dangerous verdict is
 * `blocked`, nothing touches disk, and no `force` flag anywhere in the payload is honoured.
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import { SecurityScan } from "../../skills/SecurityScan.js";
import { fitSummary } from "../spillover.js";
import { parseAction, record as toRecord, stringArg, type ToolSpec } from "../action.js";
import { renderToolInstructions } from "../web/schemas.js";
import { SKILL_DESCRIPTION_CLIP, SKILLS_LIST_BUDGET, SKILL_TOOL_SCHEMAS } from "./schemas.js";
import { recordSkillWrite } from "../../curator/lifecycle.js";
import {
  SKILL_NAME_PATTERN,
  findSkill,
  isAdvertised,
  isMutable,
  listBundle,
  listSkills,
  parseFrontmatter,
  readBody,
  removeSkillRecord,
  renderFrontmatter,
  resolveBundlePath,
  writeAtomic,
  writeSkillRecord,
  type SkillEntry,
  type SkillTrust,
} from "./store.js";

export { SKILL_TOOL_SCHEMAS, SKILLS_LIST_BUDGET } from "./schemas.js";
export { SKILL_TRUST_TIERS, listSkills, findSkill } from "./store.js";
export type { SkillEntry, SkillTrust } from "./store.js";

export const SKILLS_ADAPTER_NAME = "skills";
const DESTRUCTIVE = new Set(["delete", "remove_file"]);
const SPECS: readonly ToolSpec[] = [
  { name: "skills_list", primary: "category", signature: ["category"] },
  { name: "skill_view", primary: "name", signature: ["name"] },
  { name: "skill_manage", primary: "operations", signature: ["operations"] },
];
const ROUTING_TEXT =
  "skills, list available skills, view a skill's instructions, create or edit a reusable skill, " +
  "playbook, procedure, how do I do X, saved workflow";

const argString = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = stringArg(args, key)?.trim();
  return v ? v : undefined;
};

export interface SkillsAdapterOptions {
  /** `<profile>`; skills live in `<profile>/skills`, spillover in `<profile>/cache/spillover`. */
  profileDir: string;
  /** Override the skills directory (defaults to `<profileDir>/skills`). */
  skillsDir?: string;
  /** Tier stamped on skills this seat creates. Defaults to community. */
  createTrust?: Exclude<SkillTrust, "builtin" | "official">;
  /**
   * [D3] Who the curator's ledger records as the author of every write this adapter makes.
   * A seat id when one is known; `agent` otherwise, which is still enough for the provenance
   * policy, because what matters there is that it was not a person.
   */
  seatId?: string;
  /**
   * [D3] Run the curator's composed-skill scan gate after every write. True by default. The
   * `curator.scan_agent_skills` setting is the switch meant to feed this, but the toolset builder
   * (`tools/index.ts`) does not pass it yet, so today the gate is always on.
   */
  scanAgentSkills?: boolean;
}

type Status = ToolCallRecord["status"];
interface OpOutcome { status: Status; line: string }

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 3)}...`;
}

function opsOf(args: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(args.operations)
    ? args.operations.filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    : [];
}

export function createSkillsAdapter(options: SkillsAdapterOptions): TrentToolAdapter {
  const skillsDir = options.skillsDir ?? path.join(options.profileDir, "skills");
  const createTrust: SkillTrust = options.createTrust ?? "community";
  const seatId = options.seatId ?? "agent";
  const scanAgentSkills = options.scanAgentSkills ?? true;
  const record = (action: string, status: Status, summary: string) =>
    toRecord(SKILLS_ADAPTER_NAME, action, status, fitSummary(summary, options.profileDir, "skills"));

  function skillsList(action: string, args: Record<string, unknown>): ToolCallRecord {
    const category = argString(args, "category");
    // [D3] Archived and quarantined skills exist but are not advertised: a seat is told about
    // what it may use, and a quarantined skill waits for a human, not for a model to find it.
    const all = listSkills(skillsDir).filter(isAdvertised).filter((s) => !category || s.category === category);
    if (!all.length) return record(action, "completed", category ? `No skills in category "${category}".` : "No skills installed.");
    const header = `${all.length} skill(s). Use skill_view {"name": ...} for the full text.`;
    const lines: string[] = [];
    let used = header.length + 1;
    let shown = 0;
    for (const s of all) {
      const line = `- ${s.name} [${s.category}] (${s.trust}): ${clip(s.description || "(no description)", SKILL_DESCRIPTION_CLIP)}`;
      if (used + line.length + 80 > SKILLS_LIST_BUDGET) break;
      lines.push(line);
      used += line.length + 1;
      shown += 1;
    }
    if (shown < all.length) lines.push(`... and ${all.length - shown} more; filter by category to see them.`);
    return record(action, "completed", `${header}\n${lines.join("\n")}`);
  }

  function skillView(action: string, args: Record<string, unknown>): ToolCallRecord {
    const name = argString(args, "name");
    if (!name) return record(action, "failed", "skill_view requires \"name\".");
    const entry = findSkill(skillsDir, name);
    if (!entry) return record(action, "failed", `Skill "${name}" not found. Use skills_list to see what is installed.`);
    const filePath = argString(args, "file_path");
    if (filePath) {
      const resolved = resolveBundlePath(entry, filePath);
      if (!resolved.ok) return record(action, resolved.blocked ? "blocked" : "failed", `skill_view: ${resolved.reason}.`);
      if (!fs.existsSync(resolved.file)) return record(action, "failed", `Skill "${name}" has no file "${filePath}".`);
      return record(action, "completed", `## ${name}/${filePath}\n${fs.readFileSync(resolved.file, "utf8")}`);
    }
    let body: string;
    try {
      body = readBody(entry);
    } catch (err) {
      return record(action, "failed", `Skill "${name}" could not be read: ${(err as Error).message}`);
    }
    const bundle = listBundle(entry);
    const listing = bundle.length
      ? `\n\nBundled files (read one with file_path):\n${bundle.map((b) => `- ${b}`).join("\n")}`
      : "\n\nNo bundled files.";
    return record(action, "completed", `# ${entry.name} [${entry.category}] (${entry.trust})\n\n${body.trim()}${listing}`);
  }

  /** The one gate every write passes. Nothing is written when it returns a line. */
  function scanOrBlock(label: string, content: string): OpOutcome | null {
    const scan = SecurityScan.scan(content);
    if (scan.safe) return null;
    return { status: "blocked", line: `${label}: blocked by security scan (score ${scan.score}): ${scan.findings.join("; ")}. This verdict cannot be forced.` };
  }

  function guardMutable(entry: SkillEntry, label: string): OpOutcome | null {
    if (isMutable(entry.trust)) return null;
    return { status: "blocked", line: `${label}: "${entry.name}" is a ${entry.trust} skill and is read-only.` };
  }

  /**
   * [D3] Ledger the write, then put the COMPOSED skill — its document and its whole bundle — past
   * the scan gate. The per-operation scan above is the write gate and is unchanged; this is the
   * second one, and what it flags sits quarantined until a human runs `trent curator release`.
   * Returns the clause to append to the operation's line, empty when nothing was flagged.
   */
  function curate(
    kind: "create" | "edit" | "delete",
    name: string,
    before: string | null,
    detail: string,
  ): string {
    const outcome = recordSkillWrite({ skillsDir, name, actor: seatId, kind, before, gate: scanAgentSkills, detail });
    if (outcome.quarantine === null) return "";
    return `, quarantined by the curator's scan gate: ${outcome.findings.join("; ")}; a human must run \`trent curator release ${name}\``;
  }

  function create(op: Record<string, unknown>, name: string): OpOutcome {
    const label = `create ${name}`;
    const content = typeof op.content === "string" ? op.content : "";
    if (!content.trim()) return { status: "failed", line: `${label}: "content" is required.` };
    if (findSkill(skillsDir, name)) return { status: "failed", line: `${label}: a skill named "${name}" already exists; use patch.` };
    const category = argString(op, "category");
    if (category && !SKILL_NAME_PATTERN.test(category)) return { status: "failed", line: `${label}: invalid category "${category}".` };
    const description = argString(op, "description") ?? "";
    const blocked = scanOrBlock(label, `${description}\n${content}`);
    if (blocked) return blocked;
    // The one store's canonical form: <skills>/<category>/<name>/SKILL.md, uncategorised at depth one.
    const file = writeSkillRecord(skillsDir, {
      name,
      description,
      trust: createTrust,
      instructions: content,
      // [D3] A seat wrote it, so the curator may age it. Provenance is declared here, at the
      // one place that knows who is writing, and never inferred later from telemetry.
      createdBy: "agent",
      ...(category === undefined ? {} : { category }),
    });
    const gated = curate("create", name, null, `created ${path.relative(skillsDir, file)}`);
    return {
      status: "completed",
      line: `${label}: created ${path.relative(skillsDir, file)} (${createTrust})${gated}.`,
    };
  }

  function patch(op: Record<string, unknown>, entry: SkillEntry): OpOutcome {
    const label = `patch ${entry.name}`;
    const guard = guardMutable(entry, label);
    if (guard) return guard;
    if (entry.dir === null) {
      return {
        status: "failed",
        line: `${label}: "${entry.name}" is a legacy flat file the store could not migrate; a skill name is lowercase letters, digits, - and _.`,
      };
    }
    const oldString = typeof op.old_string === "string" ? op.old_string : "";
    const newString = typeof op.new_string === "string" ? op.new_string : "";
    if (!oldString) return { status: "failed", line: `${label}: "old_string" is required.` };
    const { fields, body } = parseFrontmatter(fs.readFileSync(entry.file, "utf8"));
    const count = body.split(oldString).length - 1;
    if (count !== 1) return { status: "failed", line: `${label}: old_string must match exactly once; matched ${count} times.` };
    const nextBody = body.replace(oldString, newString);
    const blocked = scanOrBlock(label, nextBody);
    if (blocked) return blocked;
    const before = fs.readFileSync(entry.file, "utf8");
    writeAtomic(entry.file, renderFrontmatter(fields, nextBody));
    const gated = curate("edit", entry.name, before, "patched SKILL.md");
    return { status: "completed", line: `${label}: applied${gated}.` };
  }

  function remove(entry: SkillEntry): OpOutcome {
    const label = `delete ${entry.name}`;
    const guard = guardMutable(entry, label);
    if (guard) return guard;
    const before = entry.dir === null ? null : fs.readFileSync(entry.file, "utf8");
    removeSkillRecord(skillsDir, entry.name);
    curate("delete", entry.name, before, "removed from the store");
    return { status: "completed", line: `${label}: removed.` };
  }

  function bundleFile(op: Record<string, unknown>, entry: SkillEntry, write: boolean): OpOutcome {
    const label = `${write ? "write_file" : "remove_file"} ${entry.name}`;
    const guard = guardMutable(entry, label);
    if (guard) return guard;
    const filePath = argString(op, "file_path");
    if (!filePath) return { status: "failed", line: `${label}: "file_path" is required.` };
    const resolved = resolveBundlePath(entry, filePath);
    if (!resolved.ok) return { status: resolved.blocked ? "blocked" : "failed", line: `${label}: ${resolved.reason}.` };
    const before = entry.dir === null ? null : fs.readFileSync(entry.file, "utf8");
    if (!write) {
      if (!fs.existsSync(resolved.file)) return { status: "failed", line: `${label}: no such file "${filePath}".` };
      fs.unlinkSync(resolved.file);
      const gone = curate("edit", entry.name, before, `removed bundled ${filePath}`);
      return { status: "completed", line: `${label}: removed ${filePath}${gone}.` };
    }
    const content = typeof op.content === "string" ? op.content : "";
    const blocked = scanOrBlock(label, content);
    if (blocked) return blocked;
    writeAtomic(resolved.file, content);
    const gated = curate("edit", entry.name, before, `wrote bundled ${filePath}`);
    return { status: "completed", line: `${label}: wrote ${filePath} (${content.length} chars)${gated}.` };
  }

  function runOne(op: Record<string, unknown>): OpOutcome {
    const actionName = argString(op, "action") ?? "";
    const name = argString(op, "name") ?? "";
    if (!SKILL_NAME_PATTERN.test(name)) return { status: "failed", line: `${actionName || "operation"}: invalid skill name "${name}".` };
    if (actionName === "create") return create(op, name);
    const entry = findSkill(skillsDir, name);
    if (!entry) return { status: "failed", line: `${actionName} ${name}: skill not found.` };
    switch (actionName) {
      case "patch": return patch(op, entry);
      case "delete": return remove(entry);
      case "write_file": return bundleFile(op, entry, true);
      case "remove_file": return bundleFile(op, entry, false);
      default: return { status: "failed", line: `${name}: unknown action "${actionName}".` };
    }
  }

  function skillManage(action: string, args: Record<string, unknown>): ToolCallRecord {
    const ops = opsOf(args);
    if (!ops.length) return record(action, "failed", "skill_manage requires a non-empty \"operations\" array.");
    const outcomes = ops.map(runOne);
    const status: Status = outcomes.some((o) => o.status === "blocked")
      ? "blocked"
      : outcomes.some((o) => o.status === "failed")
        ? "failed"
        : "completed";
    const note = outcomes.length > 1 ? "\nOperations are applied independently, in order; check each line." : "";
    return record(action, status, `${outcomes.map((o) => `- ${o.line}`).join("\n")}${note}`);
  }

  return {
    name: SKILLS_ADAPTER_NAME,
    scopes: [SKILLS_ADAPTER_NAME, "skills_list", "skill_view", "skill_manage"],
    availability: "real",
    instructions: renderToolInstructions(SKILL_TOOL_SCHEMAS),
    routingText: ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, args } = parseAction(action, SPECS);
      return tool === "skill_manage" && opsOf(args).some((o) => DESTRUCTIVE.has(String(o.action)));
    },
    async execute(action) {
      const { tool, args, error } = parseAction(action, SPECS);
      if (error) return record(action, "failed", error);
      try {
        if (tool === "skills_list") return skillsList(action, args);
        if (tool === "skill_view") return skillView(action, args);
        return skillManage(action, args);
      } catch (err) {
        return record(action, "failed", `${tool} failed: ${(err as Error).message}`);
      }
    },
    async dryRun(action) {
      return record(action, "mocked", `skills dry-run: would perform "${action}".`);
    },
    async cleanup() {},
  };
}
