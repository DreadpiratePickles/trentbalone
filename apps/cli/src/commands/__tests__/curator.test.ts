/**
 * D3 item 5: `trent curator`.
 *
 * Six subcommands over the one skill store, every one scriptable with `--json`, and every one that
 * takes an id answering `{dryRun, ...}` at exit 0 under `--dry-run` — the convention afe10b6 fixed
 * `fleet show` to keep, which the command registry's probe enforces for the whole surface.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { findSkillRecord, writeSkillRecord } from "@trent/core/skills/index.js";
import { recordSkillUse } from "@trent/core/skills/usage.js";
import { runCli } from "../index.js";

const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString();

let home: string;
let skillsDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-curator-"));
  process.env.TRENT_HOME = home;
  skillsDir = path.join(home, "skills");
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

async function json<T>(argv: readonly string[]): Promise<T> {
  const result = await runCli([...argv, "--json"]);
  expect(result.exitCode, result.stderr || result.stdout).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as T;
}

function seed(name: string, options: { createdBy?: string; usedDaysAgo?: number } = {}): void {
  writeSkillRecord(skillsDir, {
    name,
    description: `What ${name} does`,
    instructions: `# ${name}\nRun the ${name} procedure.`,
    createdBy: (options.createdBy ?? "agent") as "agent" | "human" | "import",
    promotedAt: daysAgo(400),
  });
  if (options.usedDaysAgo !== undefined) recordSkillUse(skillsDir, name, daysAgo(options.usedDaysAgo));
}

interface AgeJson {
  stale: string[];
  archived: string[];
  kept: string[];
  reported: { skill: string; createdBy: string }[];
  enabled: boolean;
}

describe("trent curator", () => {
  it("age moves an idle agent skill to stale and status reports the new state", async () => {
    seed("sprint-report", { usedDaysAgo: 61 });

    const aged = await json<AgeJson>(["curator", "age"]);
    expect(aged.stale).toEqual(["sprint-report"]);
    expect(aged.archived).toEqual([]);

    const status = await json<{ counts: { stale: number; eligible: number }; ledger: { count: number; verified: boolean } }>([
      "curator",
      "status",
    ]);
    expect(status.counts.stale).toBe(1);
    expect(status.counts.eligible).toBe(1);
    expect(status.ledger.count).toBe(1);
    expect(status.ledger.verified).toBe(true);
  });

  it("age reports a human skill without touching it, whatever its age", async () => {
    seed("founder-voice", { createdBy: "human", usedDaysAgo: 400 });

    const aged = await json<AgeJson>(["curator", "age"]);

    expect(aged.stale).toEqual([]);
    expect(aged.archived).toEqual([]);
    expect(aged.reported.map((r) => r.skill)).toEqual(["founder-voice"]);
    expect(findSkillRecord(skillsDir, "founder-voice")?.status).toBe("active");
  });

  it("adopt declares provenance, and log shows the row it wrote", async () => {
    seed("partner-brief", { createdBy: "import", usedDaysAgo: 400 });

    const adopted = await json<{ skill: string; createdBy: string; previous: string }>(["curator", "adopt", "partner-brief"]);
    expect(adopted.createdBy).toBe("agent");
    expect(adopted.previous).toBe("import");

    const log = await json<{ count: number; mutations: { kind: string; skill: string; actor: string }[] }>([
      "curator",
      "log",
      "partner-brief",
    ]);
    expect(log.count).toBe(1);
    expect(log.mutations[0]?.kind).toBe("adopt");
    expect(log.mutations[0]?.actor).toBe("human");
  });

  it("release clears a quarantined skill and undo reverses exactly that release", async () => {
    writeSkillRecord(skillsDir, {
      name: "deploy-runbook",
      description: "How we deploy",
      instructions: "# Deploy runbook\nCheck the build.",
      createdBy: "agent",
      status: "quarantined",
      quarantineReason: "Arbitrary remote code execution via pipe to shell",
      promotedAt: daysAgo(2),
    });

    const released = await json<{ status: string; previous: string; mutation: { id: string } }>([
      "curator",
      "release",
      "deploy-runbook",
    ]);
    expect(released.status).toBe("active");
    expect(released.previous).toBe("quarantined");
    expect(findSkillRecord(skillsDir, "deploy-runbook")?.status).toBe("active");

    const undone = await json<{ outcome: string; skill: string }>(["curator", "undo", released.mutation.id]);
    expect(undone.outcome).toBe("restored");
    expect(findSkillRecord(skillsDir, "deploy-runbook")?.status).toBe("quarantined");
  });

  it("undoing anything but the newest mutation of a skill fails and names the newer one", async () => {
    seed("weekly-digest", { usedDaysAgo: 400 });
    await json<AgeJson>(["curator", "age"]);
    const log = await json<{ mutations: { id: string; kind: string }[] }>(["curator", "log", "weekly-digest"]);
    const archived = log.mutations[0]!;
    await json<{ createdBy: string }>(["curator", "adopt", "weekly-digest", "--provenance", "human"]);

    const result = await runCli(["curator", "undo", archived.id, "--json"]);

    expect(result.exitCode).not.toBe(EXIT.OK);
    expect(`${result.stdout}${result.stderr}`).toContain("weekly-digest");
    expect(findSkillRecord(skillsDir, "weekly-digest")?.status).toBe("archived");
  });

  it("every subcommand answers {dryRun, ...} at exit 0 and writes nothing", async () => {
    seed("sprint-report", { usedDaysAgo: 400 });

    for (const argv of [
      ["curator", "status"],
      ["curator", "age"],
      ["curator", "adopt", "sprint-report"],
      ["curator", "release", "sprint-report"],
      ["curator", "undo", "mut_0000000000000000"],
      ["curator", "log"],
    ]) {
      const result = await runCli([...argv, "--json", "--dry-run"]);
      expect(result.exitCode, `${argv.join(" ")}: ${result.stderr}`).toBe(EXIT.OK);
      const parsed = JSON.parse(result.stdout) as { dryRun?: boolean; command?: string };
      expect(parsed.dryRun, argv.join(" ")).toBe(true);
      expect(parsed.command).toBe(argv.join(" "));
    }
    expect(findSkillRecord(skillsDir, "sprint-report")?.status).toBe("active");
    expect(fs.existsSync(path.join(skillsDir, ".ledger.ndjson"))).toBe(false);
  });

  it("curator.enabled false stops the aging pass and says so", async () => {
    seed("sprint-report", { usedDaysAgo: 400 });
    await runCli(["config", "set", "curator.enabled", "false"]);

    const aged = await json<AgeJson>(["curator", "age"]);

    expect(aged.enabled).toBe(false);
    expect(aged.archived).toEqual([]);
    expect(findSkillRecord(skillsDir, "sprint-report")?.status).toBe("active");
  });

  it("human rendering names the transitions without a JSON flag", async () => {
    seed("sprint-report", { usedDaysAgo: 400 });

    const result = await runCli(["curator", "age", "--no-color"]);

    expect(result.exitCode, result.stderr).toBe(EXIT.OK);
    expect(result.stdout).toContain("sprint-report");
    expect(result.stdout).toContain("archived");
  });
});
