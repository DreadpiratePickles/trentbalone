/**
 * D4 — where a goal lives: `<profileDir>/goals/<id>.json`, 0700 on the directory, 0600 on the file.
 *
 * One file per goal, written temp-then-rename, so a crash mid-write leaves the previous goal rather
 * than a truncated one. A goal carries gates, and a gate is an argv that will be executed: a
 * half-written gate array is exactly the thing that must never be readable.
 *
 * The id is checked before it becomes a path. It is the only part of the record a caller can choose
 * freely, so it is the only part that could point at another directory.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GOALS_DIR_MODE, GOALS_FILE_MODE, GoalError, type GoalGate, type GoalRecord } from "./types.js";

const GOAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CreateGoalInput {
  readonly objective: string;
  /** What "done" means for this goal, in the user's words. The objective when none is given. */
  readonly contract?: string;
  readonly gates?: readonly GoalGate[];
  readonly id?: string;
  readonly at?: string;
}

export function newGoalId(): string {
  return `goal_${randomBytes(6).toString("hex")}`;
}

export class GoalStore {
  readonly root: string;

  constructor(profileDir: string) {
    this.root = path.join(profileDir, "goals");
  }

  private file(id: string): string {
    if (!GOAL_ID.test(id) || id.includes("..")) {
      throw new GoalError(`goal id ${JSON.stringify(id)} is not a safe file name`);
    }
    return path.join(this.root, `${id}.json`);
  }

  private mkdir(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: GOALS_DIR_MODE });
    try {
      fs.chmodSync(this.root, GOALS_DIR_MODE);
    } catch {
      // A mount that refuses chmod still has to be usable; the id check above is the wall.
    }
  }

  create(input: CreateGoalInput): GoalRecord {
    const objective = input.objective.trim();
    if (objective === "") throw new GoalError("a goal needs an objective");
    const record: GoalRecord = {
      id: input.id ?? newGoalId(),
      objective,
      contract: (input.contract ?? objective).trim(),
      gates: [...(input.gates ?? [])],
      status: "open",
      created_at: input.at ?? new Date().toISOString(),
      runs: [],
      continuations: 0,
    };
    return this.save(record);
  }

  /** Writes the record and returns it, so a caller can chain a read-modify-write in one expression. */
  save(record: GoalRecord): GoalRecord {
    const target = this.file(record.id);
    this.mkdir();
    const tmp = `${target}.${process.pid}.trent-goal`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: GOALS_FILE_MODE });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, GOALS_FILE_MODE);
    return record;
  }

  get(id: string): GoalRecord | undefined {
    const target = this.file(id);
    if (!fs.existsSync(target)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(target, "utf8")) as GoalRecord;
    } catch {
      // A goal nobody can parse is a goal nobody can act on; it is reported as absent, not thrown,
      // so one corrupt file cannot take `trent goal list` down with it.
      return undefined;
    }
  }

  /** Every readable goal, newest first. */
  list(): GoalRecord[] {
    if (!fs.existsSync(this.root)) return [];
    const ids = fs
      .readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    const rows: GoalRecord[] = [];
    for (const id of ids) {
      const record = GOAL_ID.test(id) ? this.get(id) : undefined;
      if (record !== undefined) rows.push(record);
    }
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
