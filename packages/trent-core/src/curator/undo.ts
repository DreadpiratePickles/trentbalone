/**
 * [D3] Single-mutation rollback.
 *
 * `trent curator undo <id>` reverses exactly one mutation by putting its `before` blob back, and
 * appends its own row saying so. It refuses to reverse anything but the newest mutation of that
 * skill, naming the newer one: reversing a mutation with later changes stacked on top of it would
 * silently discard those later changes, and a ledger whose middle can be rewritten proves nothing.
 * Undo the newer mutation first, or leave it alone.
 */
import fs from "node:fs";
import path from "node:path";

import {
  SKILL_FILE,
  findSkillRecord,
  parseFrontmatter,
  removeSkillRecord,
  skillDirFor,
  writeSkillFile,
  type SkillRecord,
} from "../skills/skill-store.js";
import { appendMutation, putSkillBlob, readMutations, readSkillBlob } from "./ledger.js";
import { HUMAN_ACTOR, type CuratorMutation } from "./types.js";

export interface UndoOptions {
  skillsDir: string;
  id: string;
  actor?: string;
  now?: string;
}

export interface UndoResult {
  /** The mutation that was reversed. */
  undone: CuratorMutation;
  /** The row this undo appended. */
  mutation: CuratorMutation;
  /** What the skill is now: `restored`, or `removed` when the undone mutation created it. */
  outcome: "restored" | "removed";
  skill: string;
}

/** The canonical path a restored document belongs at, read from the blob's own frontmatter. */
function pathForBlob(skillsDir: string, name: string, document: string): string {
  const { fields } = parseFrontmatter(document);
  return path.join(skillDirFor(skillsDir, name, fields.category), SKILL_FILE);
}

/** Put the bytes back where the skill lives now, moving it if its category changed since. */
function restoreDocument(skillsDir: string, name: string, document: string, current: SkillRecord | null): void {
  const target = pathForBlob(skillsDir, name, document);
  if (current?.dir != null && path.resolve(current.file) !== path.resolve(target)) {
    fs.rmSync(current.dir, { recursive: true, force: true });
  }
  writeSkillFile(target, document);
}

export function undoMutation(options: UndoOptions): UndoResult {
  const { skillsDir, id } = options;
  const now = options.now ?? new Date().toISOString();
  const actor = options.actor ?? HUMAN_ACTOR;

  const all = readMutations(skillsDir);
  const index = all.findIndex((row) => row.id === id);
  if (index < 0) throw new Error(`mutation ${id} is not in this profile's skill ledger`);
  const target = all[index]!;

  const newer = all.slice(index + 1).find((row) => row.skill === target.skill);
  if (newer !== undefined) {
    throw new Error(
      `refusing to undo ${id}: "${target.skill}" was changed again by ${newer.id} (${newer.kind}, ${newer.createdAt}); undo that first`,
    );
  }

  const current = findSkillRecord(skillsDir, target.skill);
  let outcome: UndoResult["outcome"];
  let after: string | null;
  if (target.before === null) {
    // The mutation created the skill: reversing it removes what it created.
    removeSkillRecord(skillsDir, target.skill);
    outcome = "removed";
    after = null;
  } else {
    const document = readSkillBlob(skillsDir, target.before);
    restoreDocument(skillsDir, target.skill, document, current);
    outcome = "restored";
    after = putSkillBlob(skillsDir, document);
  }

  const mutation = appendMutation(skillsDir, {
    skill: target.skill,
    kind: "undo",
    actor,
    before: target.after,
    after,
    detail: `reversed ${target.kind} ${target.id}`,
    undoes: target.id,
    now,
  });
  return { undone: target, mutation, outcome, skill: target.skill };
}
