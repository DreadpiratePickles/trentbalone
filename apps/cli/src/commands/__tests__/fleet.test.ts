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
import { CORE_ROLE_IDS, SEAT_CAPABILITIES, seatCapability } from "@trent/core/fleet/index.js";
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

describe("trent fleet list", () => {
  interface ListData {
    count: number;
    total: number;
    agents: Array<{ id: string; name: string; category: string }>;
  }

  it("lists the nine seats the orchestrator can assign, sales among them and no browser seat", async () => {
    const result = await runCli(["fleet", "list", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);

    const data = JSON.parse(result.stdout) as ListData;
    const ids = data.agents.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(data.total).toBe(data.agents.length);

    const byId = new Map(data.agents.map((agent) => [agent.id, agent]));
    expect(CORE_ROLE_IDS.length).toBe(9);
    for (const seat of CORE_ROLE_IDS) expect(byId.has(seat), `seat ${seat} is missing`).toBe(true);
    // The ninth seat is sales, filed under the catalog division of the same name.
    expect(byId.get("sales")?.category).toBe("sales");
    // `browser` is a toolset every seat may enable, never a seat of its own.
    expect(byId.has("browser")).toBe(false);
  });

  it("renders the sales seat in the human listing", async () => {
    const result = await runCli(["fleet", "list"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("sales");
    expect(result.stdout).not.toContain("browser");
  });
});

describe("trent fleet show", () => {
  interface ShowData {
    seat: string;
    name: string;
    toolsets: string[];
    unavailable: Array<{ capability: string; reason: string }>;
    denied: string[];
    approvalGates: string[];
    budgetCents: number;
    modelTier: string;
    model: string;
    evalSuiteId: string;
  }

  async function show(seat: string): Promise<ShowData> {
    const result = await runCli(["fleet", "show", seat, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    return JSON.parse(result.stdout) as ShowData;
  }

  it("prints what makes each seat a seat: toolsets, unavailable capabilities, floor overrides, cents, tier and suite", async () => {
    const engineer = await show("engineer");
    expect(engineer.seat).toBe("engineer");
    expect(engineer.toolsets).toContain("terminal");
    expect(engineer.budgetCents).toBe(seatCapability("engineer").budgetCents);
    expect(Number.isInteger(engineer.budgetCents)).toBe(true);
    expect(engineer.modelTier).toBe(seatCapability("engineer").modelTier);
    expect(engineer.evalSuiteId).toBe("engineer");
    expect(engineer.unavailable.map((entry) => entry.capability)).toContain("GitHub");
    expect(engineer.model.length).toBeGreaterThan(0);

    const finance = await show("finance");
    expect(finance.toolsets).not.toContain("terminal");
    expect(finance.denied).toContain("terminal");
    expect(finance.budgetCents).not.toBe(engineer.budgetCents);
    expect(finance.approvalGates).toContain("payout");
  });

  it("every seat in the roster has a budget, a tier and an eval suite id", async () => {
    for (const seat of CORE_ROLE_IDS) {
      const data = await show(seat);
      expect(data.evalSuiteId, seat).toBe(seat);
      expect(data.budgetCents, seat).toBeGreaterThan(0);
      expect(["haiku", "sonnet", "opus"], seat).toContain(data.modelTier);
    }
  });

  it("renders the seat for a human too, in cents", async () => {
    const result = await runCli(["fleet", "show", "finance"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("finance");
    expect(result.stdout).toContain(String(seatCapability("finance").budgetCents));
    expect(result.stdout).toContain("unavailable");
  });

  it("refuses a seat the application does not define", async () => {
    const result = await runCli(["fleet", "show", "browser", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(`${result.stdout}${result.stderr}`).toContain("browser");
  });

  // Every other command that takes an id — `sessions resume <id>`, `jobs retry <id>`,
  // `improve promote <draftId>`, `fleet install <agentId>` — answers `--dry-run` with a
  // `{ dryRun, command, ... }` payload and exit 0, reporting existence instead of throwing
  // (`improve promote` reports `exists`, `mcp test` reports `configured`). `fleet show` must do
  // the same, or the registry invariant cannot probe it with a placeholder argument.
  it("--dry-run reports whether the seat is defined instead of refusing, the way every other id command does", async () => {
    const unknown = await runCli(["fleet", "show", "sample", "--dry-run", "--json"]);
    expect(unknown.exitCode).toBe(EXIT.OK);
    const unknownData = JSON.parse(unknown.stdout) as { roster: string[] };
    expect(unknownData).toMatchObject({ dryRun: true, command: "fleet show", seat: "sample", defined: false });
    expect(unknownData.roster).toEqual(Object.keys(SEAT_CAPABILITIES));

    const known = await runCli(["fleet", "show", "engineer", "--dry-run", "--json"]);
    expect(known.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(known.stdout)).toMatchObject({ dryRun: true, command: "fleet show", seat: "engineer", defined: true });

    const human = await runCli(["fleet", "show", "sample", "--dry-run"]);
    expect(human.exitCode).toBe(EXIT.OK);
    expect(human.stdout).toContain("sample");
  });
});

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
