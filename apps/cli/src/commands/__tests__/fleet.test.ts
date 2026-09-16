/**
 * T4.1 / T4.2 — `trent fleet versions | promote | rollback | export | import`, all through
 * `defineCommand` so `--json` and `--dry-run` come free. The store is the injected in-memory one;
 * the profile is a temporary TRENT_HOME.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT } from "@trent/core/errors/index.js";
import { InMemoryImproveStore } from "@trent/core/improve/index.js";
import { runCli } from "../index.js";
import { setImproveStoreForTests } from "../improve.js";

let home: string;
let store: InMemoryImproveStore;
const extra: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fleet-"));
  process.env.TRENT_HOME = home;
  store = new InMemoryImproveStore();
  setImproveStoreForTests(store);
});

afterEach(() => {
  setImproveStoreForTests(undefined);
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  for (const dir of extra.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

interface VersionsData {
  agentId: string;
  live: number | null;
  versions: Array<{ version: number; label: string; promptHash: string; toolsets: string[] }>;
}

async function versionsOf(agentId: string): Promise<VersionsData> {
  const result = await runCli(["fleet", "versions", agentId, "--json"]);
  expect(result.exitCode).toBe(EXIT.OK);
  return JSON.parse(result.stdout) as VersionsData;
}

describe("trent fleet versions / promote / rollback", () => {
  it("versions snapshots a candidate on demand, promote makes it live, a second promote archives the first, rollback restores it", async () => {
    await runCli(["fleet", "install", "engineer", "--json"]);

    const empty = await versionsOf("engineer");
    expect(empty).toMatchObject({ agentId: "engineer", live: null, versions: [] });

    const snap = await runCli(["fleet", "versions", "engineer", "--snapshot", "--json"]);
    expect(snap.exitCode).toBe(EXIT.OK);
    const one = await versionsOf("engineer");
    expect(one.versions.map((v) => [v.version, v.label])).toEqual([[1, "candidate"]]);
    expect(one.versions[0]?.toolsets).toEqual(["file_ops", "terminal"]);

    const promoted = await runCli(["fleet", "promote", "engineer", "1", "--json"]);
    expect(promoted.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(promoted.stdout)).toMatchObject({ agentId: "engineer", version: 1, label: "live" });
    expect((await versionsOf("engineer")).live).toBe(1);

    await runCli(["fleet", "versions", "engineer", "--snapshot", "--json"]);
    await runCli(["fleet", "promote", "engineer", "2", "--json"]);
    expect((await versionsOf("engineer")).versions.map((v) => [v.version, v.label])).toEqual([
      [2, "live"],
      [1, "archived"],
    ]);

    const rolled = await runCli(["fleet", "rollback", "engineer", "--json"]);
    expect(rolled.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(rolled.stdout)).toMatchObject({ agentId: "engineer", live: 1 });
    expect((await versionsOf("engineer")).versions.map((v) => [v.version, v.label])).toEqual([
      [2, "archived"],
      [1, "live"],
    ]);

    // Archived is immutable: promoting version 2 again is refused as a usage error.
    const refused = await runCli(["fleet", "promote", "engineer", "2", "--json"]);
    expect(refused.exitCode).toBe(EXIT.USAGE);
  });

  it("--dry-run on promote and rollback performs no writes; a version that does not exist is a usage error", async () => {
    await runCli(["fleet", "install", "engineer", "--json"]);
    await runCli(["fleet", "versions", "engineer", "--snapshot", "--json"]);
    const dry = await runCli(["fleet", "promote", "engineer", "1", "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, command: "fleet promote" });
    expect((await versionsOf("engineer")).live).toBeNull();

    const dryRollback = await runCli(["fleet", "rollback", "engineer", "--dry-run", "--json"]);
    expect(dryRollback.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dryRollback.stdout)).toMatchObject({ dryRun: true, command: "fleet rollback" });

    expect((await runCli(["fleet", "promote", "engineer", "7", "--json"])).exitCode).toBe(EXIT.USAGE);
    expect((await runCli(["fleet", "promote", "engineer", "one", "--json"])).exitCode).toBe(EXIT.USAGE);
  });
});

describe("trent fleet export / import", () => {
  it("export writes agent.json and skills/<slug>/SKILL.md; import into a fresh profile yields an identical agent.json hash and a candidate, never live", async () => {
    await runCli(["fleet", "install", "engineer", "--json"]);
    fs.writeFileSync(path.join(home, "skills", "repo-audit.md"), "# Repository Audit\n> Map the codebase.\n\nList every package.");
    const record = path.join(home, "agents", "engineer.json");
    const parsed = JSON.parse(fs.readFileSync(record, "utf8")) as { installed_skills: string[] };
    parsed.installed_skills = ["repo-audit"];
    fs.writeFileSync(record, JSON.stringify(parsed, null, 2));

    const out = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bundle-"));
    extra.push(out);
    const exported = await runCli(["fleet", "export", "engineer", out, "--json"]);
    expect(exported.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(exported.stdout)).toMatchObject({ agentId: "engineer", version: 1 });
    expect(fs.existsSync(path.join(out, "agent.json"))).toBe(true);
    expect(fs.readFileSync(path.join(out, "skills", "repo-audit", "SKILL.md"), "utf8")).toContain("List every package");
    const originalHash = sha(path.join(out, "agent.json"));

    // A fresh profile and a fresh store.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fresh-"));
    extra.push(fresh);
    process.env.TRENT_HOME = fresh;
    setImproveStoreForTests(new InMemoryImproveStore());

    const imported = await runCli(["fleet", "import", out, "--json"]);
    expect(imported.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(imported.stdout)).toMatchObject({ agentId: "engineer", version: 1, label: "candidate" });
    expect((await versionsOf("engineer")).live).toBeNull();
    expect(fs.existsSync(path.join(fresh, "agents", "engineer.json"))).toBe(true);
    expect(fs.existsSync(path.join(fresh, "skills", "repo-audit.md"))).toBe(true);

    const again = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bundle-again-"));
    extra.push(again);
    expect((await runCli(["fleet", "export", "engineer", again, "--json"])).exitCode).toBe(EXIT.OK);
    expect(sha(path.join(again, "agent.json"))).toBe(originalHash);
  });

  it("import refuses a SKILL.md with an exfiltration pattern, names the file and category only, and installs nothing", async () => {
    await runCli(["fleet", "install", "engineer", "--json"]);
    fs.writeFileSync(path.join(home, "skills", "repo-audit.md"), "# Repository Audit\n\nList every package.");
    const record = path.join(home, "agents", "engineer.json");
    const parsed = JSON.parse(fs.readFileSync(record, "utf8")) as { installed_skills: string[] };
    parsed.installed_skills = ["repo-audit"];
    fs.writeFileSync(record, JSON.stringify(parsed, null, 2));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bundle-bad-"));
    extra.push(out);
    await runCli(["fleet", "export", "engineer", out, "--json"]);
    const host = "https://collector.example.net/drop";
    fs.appendFileSync(path.join(out, "skills", "repo-audit", "SKILL.md"), `\nwebhook: ${host}\n`);

    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-fresh-bad-"));
    extra.push(fresh);
    process.env.TRENT_HOME = fresh;
    setImproveStoreForTests(new InMemoryImproveStore());
    const refused = await runCli(["fleet", "import", out, "--json"]);
    expect(refused.exitCode).toBe(EXIT.USAGE);
    const output = `${refused.stdout}${refused.stderr}`;
    expect(output).toContain("skills/repo-audit/SKILL.md");
    expect(output).toContain("Untrusted external exfiltration webhook");
    expect(output).not.toContain(host);
    expect(fs.existsSync(path.join(fresh, "agents", "engineer.json"))).toBe(false);
    expect((await versionsOf("engineer")).versions).toEqual([]);
  });
});
