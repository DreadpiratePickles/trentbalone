/**
 * D3 items 1 and 3: the skill lifecycle the curator ages, and declared provenance as the policy
 * that decides what it is allowed to touch.
 *
 * Aging is measured from USE, and use is recorded when a seat's run loads the skill, so a skill
 * nobody loads decays and a skill in daily use never does. Provenance is declared, never inferred:
 * a skill a person installed is reported and left alone however old it gets.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findSkillRecord,
  listAdvertisedSkillRecords,
  writeSkillRecord,
  type SkillProvenance,
  type SkillStatus,
} from "../skills/skill-store.js";
import { recordSkillUse } from "../skills/usage.js";
import { adoptSkill, ageSkills, curatorStatus } from "./index.js";
import { readMutations } from "./ledger.js";

const NOW = "2026-09-18T00:00:00.000Z";
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-curator-life-"));
});

afterEach(() => {
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

interface Seed {
  createdBy?: SkillProvenance;
  status?: SkillStatus;
  usedDaysAgo?: number;
  promotedDaysAgo?: number;
}

function seed(name: string, options: Seed = {}): void {
  writeSkillRecord(skillsDir, {
    name,
    description: `What ${name} does`,
    instructions: `# ${name}\nRun the ${name} procedure end to end.`,
    createdBy: options.createdBy ?? "agent",
    status: options.status ?? "active",
    promotedAt: ago(options.promotedDaysAgo ?? 400),
  });
  if (options.usedDaysAgo !== undefined) recordSkillUse(skillsDir, name, ago(options.usedDaysAgo));
}

const statusOf = (name: string): SkillStatus | undefined => findSkillRecord(skillsDir, name)?.status;

describe("curator lifecycle: active, stale, archived", () => {
  it("an agent skill unused past stale_after_days becomes stale, and the transition is ledgered", () => {
    seed("triage-inbox", { usedDaysAgo: 61 });

    const report = ageSkills({ skillsDir, now: NOW });

    expect(report.stale).toEqual(["triage-inbox"]);
    expect(report.archived).toEqual([]);
    expect(statusOf("triage-inbox")).toBe("stale");
    const rows = readMutations(skillsDir, { skill: "triage-inbox" });
    expect(rows.map((r) => r.kind)).toEqual(["age"]);
    expect(rows[0]?.actor).toBe("curator");
    expect(rows[0]?.detail).toContain("active");
    expect(rows[0]?.detail).toContain("stale");
  });

  it("a stale agent skill unused past archive_after_days is archived, unadvertised and still restorable", () => {
    seed("quarterly-board-pack", { status: "stale", usedDaysAgo: 181 });

    const report = ageSkills({ skillsDir, now: NOW });

    expect(report.archived).toEqual(["quarterly-board-pack"]);
    expect(statusOf("quarterly-board-pack")).toBe("archived");
    expect(listAdvertisedSkillRecords(skillsDir).map((s) => s.name)).not.toContain("quarterly-board-pack");
    // Not advertised is not deleted: the record and its body are still there to restore.
    expect(findSkillRecord(skillsDir, "quarterly-board-pack")?.instructions).toContain("quarterly-board-pack procedure");
    expect(readMutations(skillsDir, { skill: "quarterly-board-pack" }).map((r) => r.kind)).toEqual(["archive"]);
  });

  it("an agent skill still in use is kept, and nothing is written for it", () => {
    seed("daily-standup", { usedDaysAgo: 2 });

    const report = ageSkills({ skillsDir, now: NOW });

    expect(report.kept).toEqual(["daily-standup"]);
    expect(statusOf("daily-standup")).toBe("active");
    expect(readMutations(skillsDir)).toHaveLength(0);
  });

  it("aging is measured from the last load, so a seat loading the skill resets the clock", () => {
    seed("weekly-metrics", { usedDaysAgo: 90 });
    expect(ageSkills({ skillsDir, now: NOW }).stale).toEqual(["weekly-metrics"]);

    recordSkillUse(skillsDir, "weekly-metrics", ago(1));
    const second = ageSkills({ skillsDir, now: NOW });

    expect(second.stale).toEqual([]);
    expect(second.kept).toEqual(["weekly-metrics"]);
  });

  it("the thresholds come from the caller, so the heartbeat can run the same function", () => {
    seed("catch-up", { usedDaysAgo: 8 });

    const report = ageSkills({ skillsDir, now: NOW, staleAfterDays: 7, archiveAfterDays: 30 });

    expect(report.stale).toEqual(["catch-up"]);
  });
});

describe("curator lifecycle: declared provenance is the autonomy policy", () => {
  it("a human-authored skill past both thresholds is reported and never aged", () => {
    seed("founder-voice", { createdBy: "human", usedDaysAgo: 400 });

    const report = ageSkills({ skillsDir, now: NOW });

    expect(report.stale).toEqual([]);
    expect(report.archived).toEqual([]);
    expect(statusOf("founder-voice")).toBe("active");
    expect(report.reported.map((r) => r.skill)).toContain("founder-voice");
    expect(report.reported.find((r) => r.skill === "founder-voice")?.createdBy).toBe("human");
    expect(readMutations(skillsDir)).toHaveLength(0);
  });

  it("an imported skill is reported and never aged either", () => {
    seed("partner-playbook", { createdBy: "import", usedDaysAgo: 400 });

    const report = ageSkills({ skillsDir, now: NOW });

    expect(report.archived).toEqual([]);
    expect(statusOf("partner-playbook")).toBe("active");
    expect(report.reported.map((r) => r.skill)).toContain("partner-playbook");
  });

  it("adopt sets provenance explicitly, and only then does the curator age it", () => {
    seed("import-sweep", { createdBy: "import", usedDaysAgo: 400 });
    expect(ageSkills({ skillsDir, now: NOW }).archived).toEqual([]);

    const adopted = adoptSkill({ skillsDir, name: "import-sweep", actor: "human", now: NOW });
    expect(adopted.createdBy).toBe("agent");
    expect(findSkillRecord(skillsDir, "import-sweep")?.createdBy).toBe("agent");
    expect(readMutations(skillsDir, { skill: "import-sweep" }).map((r) => r.kind)).toEqual(["adopt"]);

    expect(ageSkills({ skillsDir, now: NOW }).archived).toEqual(["import-sweep"]);
  });

  it("status reports every skill with its provenance, status and idle days", () => {
    seed("agent-one", { usedDaysAgo: 3 });
    seed("human-one", { createdBy: "human", usedDaysAgo: 3 });

    const status = curatorStatus({ skillsDir, now: NOW });

    expect(status.counts.active).toBe(2);
    expect(status.counts.eligible).toBe(1);
    const row = status.skills.find((s) => s.skill === "agent-one");
    expect(row?.createdBy).toBe("agent");
    expect(row?.idleDays).toBe(3);
    expect(row?.useCount).toBe(1);
    expect(status.ledger.verified).toBe(true);
  });
});
