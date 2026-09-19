/**
 * D3 item 2: the append-only mutation ledger.
 *
 * One row per change to a skill, hash-chained the way the audit export is chained, with the
 * before and after bodies kept as content-addressed blobs beside it. `undo` reverses exactly one
 * mutation and is itself a row; undoing anything but the newest mutation of a skill is refused,
 * naming the newer one, because a ledger that lets you rewrite the middle is not a ledger.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findSkillRecord, writeSkillRecord } from "../skills/skill-store.js";
import { recordSkillUse } from "../skills/usage.js";
import { ageSkills } from "./lifecycle.js";
import {
  BLOBS_DIR,
  GENESIS_HASH,
  LEDGER_FILE,
  appendMutation,
  blobPath,
  readMutations,
  readSkillBlob,
  verifyMutationChain,
} from "./ledger.js";
import { undoMutation } from "./undo.js";

const NOW = "2026-09-18T00:00:00.000Z";
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-curator-ledger-"));
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

/** An agent skill loaded 61 days ago: one `age` pass away from stale, two from nothing. */
function seed(name: string, body = "original body"): void {
  writeSkillRecord(skillsDir, {
    name,
    description: `What ${name} does`,
    instructions: `# ${name}\n${body}`,
    createdBy: "agent",
    promotedAt: ago(400),
  });
  recordSkillUse(skillsDir, name, ago(61));
}

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("curator mutation ledger", () => {
  it("chains every row to its predecessor, starting from genesis, 0600 beside 0700 blobs", () => {
    seed("alpha");
    seed("beta");

    ageSkills({ skillsDir, now: NOW });
    const rows = readMutations(skillsDir);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    for (const row of rows) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.id).toMatch(/^mut_[0-9a-f]{16}$/);
    }
    expect(verifyMutationChain(skillsDir).ok).toBe(true);

    expect(mode(path.join(skillsDir, LEDGER_FILE))).toBe(0o600);
    expect(mode(path.join(skillsDir, BLOBS_DIR))).toBe(0o700);
    const ref = rows[0]?.before ?? "";
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(blobPath(skillsDir, ref))).toBe(0o600);
    // Content addressing: the ref IS the sha256 of the bytes it names.
    const blob = readSkillBlob(skillsDir, ref);
    expect(createHash("sha256").update(blob, "utf8").digest("hex")).toBe(ref);
    expect(blob).toContain("original body");
  });

  it("a tampered row breaks the chain and verification names the line", () => {
    seed("gamma");
    ageSkills({ skillsDir, now: NOW });
    const file = path.join(skillsDir, LEDGER_FILE);
    const rows = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    const forged = { ...(JSON.parse(rows[0]!) as Record<string, unknown>), actor: "someone-else" };
    fs.writeFileSync(file, `${JSON.stringify(forged)}\n`, { mode: 0o600 });

    const verdict = verifyMutationChain(skillsDir);

    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.line : 0).toBe(1);
  });

  it("a body the store has already seen reuses its blob instead of copying it per row", () => {
    seed("delta");
    ageSkills({ skillsDir, now: NOW });
    const aged = readMutations(skillsDir, { skill: "delta" })[0]!;
    const blobsAfterAge = fs.readdirSync(path.join(skillsDir, BLOBS_DIR)).length;

    // Undo restores exactly the bytes the age row recorded as `before`.
    undoMutation({ skillsDir, id: aged.id, actor: "human", now: NOW });
    const undone = readMutations(skillsDir, { skill: "delta" })[1]!;

    expect(undone.after).toBe(aged.before);
    expect(fs.readdirSync(path.join(skillsDir, BLOBS_DIR))).toHaveLength(blobsAfterAge);
  });
});

describe("curator undo: exactly one mutation", () => {
  it("undo restores the before blob and appends its own row naming what it reversed", () => {
    seed("zeta");
    ageSkills({ skillsDir, now: NOW });
    const aged = readMutations(skillsDir, { skill: "zeta" })[0]!;
    expect(findSkillRecord(skillsDir, "zeta")?.status).toBe("stale");

    const result = undoMutation({ skillsDir, id: aged.id, actor: "human", now: NOW });

    expect(result.undone.id).toBe(aged.id);
    expect(findSkillRecord(skillsDir, "zeta")?.status).toBe("active");
    const rows = readMutations(skillsDir, { skill: "zeta" });
    expect(rows.map((r) => r.kind)).toEqual(["age", "undo"]);
    expect(rows[1]?.undoes).toBe(aged.id);
    expect(rows[1]?.actor).toBe("human");
    expect(verifyMutationChain(skillsDir).ok).toBe(true);
  });

  it("undoing a non-latest mutation of a skill is refused and names the newer mutation", () => {
    seed("eta");
    ageSkills({ skillsDir, now: NOW });
    const aged = readMutations(skillsDir, { skill: "eta" })[0]!;
    // A second mutation on the same skill: the aged row is no longer the newest.
    const adopted = appendMutation(skillsDir, { skill: "eta", kind: "adopt", actor: "human", before: null, after: null, now: NOW });

    expect(() => undoMutation({ skillsDir, id: aged.id, actor: "human", now: NOW })).toThrow(adopted.id);
    expect(findSkillRecord(skillsDir, "eta")?.status).toBe("stale");
    expect(readMutations(skillsDir, { skill: "eta" })).toHaveLength(2);
  });

  it("an unknown mutation id is refused without touching the ledger", () => {
    seed("theta");
    ageSkills({ skillsDir, now: NOW });

    expect(() => undoMutation({ skillsDir, id: "mut_0000000000000000", actor: "human", now: NOW })).toThrow(/mut_0000000000000000/);
    expect(readMutations(skillsDir)).toHaveLength(1);
  });

  it("undo of an undo is refused: the undo row is itself the newest mutation of that skill", () => {
    seed("iota");
    ageSkills({ skillsDir, now: NOW });
    const aged = readMutations(skillsDir, { skill: "iota" })[0]!;
    undoMutation({ skillsDir, id: aged.id, actor: "human", now: NOW });

    expect(() => undoMutation({ skillsDir, id: aged.id, actor: "human", now: NOW })).toThrow(/mut_/);
  });
});
