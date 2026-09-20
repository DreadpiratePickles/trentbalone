/**
 * [C2] `trent brain status | log [n] | show <path>`: the read-only face of `<profile>/brain/`.
 *
 * Read-only is the property under test. There is no subcommand that writes, and `show` refuses a
 * path that leaves the brain even though the caller is a human at a terminal — the same guard the
 * `brain_read` tool uses, because a path pasted from a model is still a path from a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { EXIT } from "@trent/core/errors/index.js";
import { createBrain, type BrainExec } from "@trent/core/fleet-memory/index.js";
import { runCli } from "../index.js";

let home: string;
let profileDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-brain-")));
  process.env.TRENT_HOME = home;
  profileDir = home;
  fs.writeFileSync(path.join(profileDir, "config.yaml"), "provider: google\n", "utf8");
  fs.writeFileSync(path.join(profileDir, "secret.env"), "GEMINI_API_KEY=never-read-this", "utf8");
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function seed(exec: BrainExec = noGit): ReturnType<typeof createBrain> {
  const brain = createBrain({ profileDir, exec, now: () => new Date("2026-09-18T09:00:00.000Z") });
  brain.ensure();
  brain.recordDecision({ title: "Sales is the ninth seat", body: "browser becomes a toolset.", writer: "human", runId: "run-9" });
  brain.appendNote({ text: "the churn analysis landed", writer: "analyst", runId: "run-9" });
  return brain;
}

const json = async (...argv: string[]): Promise<{ exitCode: number; data: Record<string, unknown> }> => {
  const result = await runCli([...argv, "--json"]);
  return { exitCode: result.exitCode, data: result.stdout.trim() === "" ? {} : (JSON.parse(result.stdout) as Record<string, unknown>) };
};

describe("trent brain", () => {
  it("status reports the layout, and whether versioning is on", async () => {
    seed();
    const { exitCode, data } = await json("brain", "status");
    expect(exitCode).toBe(EXIT.OK);
    expect(data.root).toBe(path.join(profileDir, "brain"));
    expect(data.versioning).toBe(false);
    expect(data.counts).toMatchObject({ decisions: 1, memory: 1 });
    expect(JSON.stringify(data)).not.toContain("the churn analysis landed");
  });

  it("status says the brain has not been created yet, and creates nothing", async () => {
    const { exitCode, data } = await json("brain", "status");
    expect(exitCode).toBe(EXIT.OK);
    expect(data.exists).toBe(false);
    expect(fs.existsSync(path.join(profileDir, "brain"))).toBe(false);
  });

  it("log lists commits, and says so when there are none to list", async () => {
    seed();
    const { exitCode, data } = await json("brain", "log", "3");
    expect(exitCode).toBe(EXIT.OK);
    expect(data.versioning).toBe(false);
    expect(data.commits).toEqual([]);
  });

  it("show prints one brain file", async () => {
    seed();
    const { exitCode, data } = await json("brain", "show", "decisions/2026-09-18-sales-is-the-ninth-seat.md");
    expect(exitCode).toBe(EXIT.OK);
    expect(String(data.content)).toContain("browser becomes a toolset.");
    expect(data.path).toBe("decisions/2026-09-18-sales-is-the-ninth-seat.md");
  });

  it("show refuses a path that leaves the brain, and never prints the file", async () => {
    seed();
    for (const bad of ["../secret.env", "/etc/passwd", "decisions/../../secret.env"]) {
      const result = await runCli(["brain", "show", bad, "--json"]);
      expect(result.exitCode).not.toBe(EXIT.OK);
      expect(`${result.stdout}${result.stderr}`).not.toContain("never-read-this");
    }
  });

  it("show says so for a file that is not there", async () => {
    seed();
    const result = await runCli(["brain", "show", "decisions/nothing-here.md", "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(`${result.stdout}${result.stderr}`).toContain("nothing-here.md");
  });

  it("show answers a dry run with a payload and exit 0, reading nothing", async () => {
    seed();
    // The registry invariant probes every command that takes an argument with a placeholder and
    // `--dry-run`; a refusal there would look like a broken command rather than a guarded one.
    const placeholder = await json("brain", "show", "sample", "--dry-run");
    expect(placeholder.exitCode).toBe(EXIT.OK);
    expect(placeholder.data).toMatchObject({ dryRun: true, command: "brain show", path: "sample", inside: true, exists: false });

    const present = await json("brain", "show", "decisions/2026-09-18-sales-is-the-ninth-seat.md", "--dry-run");
    expect(present.data).toMatchObject({ exists: true });
    expect(JSON.stringify(present.data)).not.toContain("browser becomes a toolset.");

    const outside = await json("brain", "show", "../secret.env", "--dry-run");
    expect(outside.exitCode).toBe(EXIT.OK);
    expect(outside.data).toMatchObject({ inside: false, exists: false });
    expect(JSON.stringify(outside.data)).not.toContain("never-read-this");
  });

  it("renders human output without emoji", async () => {
    seed();
    const result = await runCli(["brain", "status"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(/\p{Extended_Pictographic}/u.test(result.stdout)).toBe(false);
    expect(result.stdout).toContain("brain");
  });
});

describe("trent brain import | docs | forget", () => {
  const handbook = (): string =>
    `# Staff handbook\n\n## Parking\n\n${"Park at the back of the building, never on the street. ".repeat(30)}\n\n## Refund policy\n\nWe issue refunds within fourteen days of a cancellation request.\n`;

  it("imports files and a directory, listing what it wrote with chunk counts", async () => {
    seed();
    const src = path.join(home, "drop");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "handbook.md"), handbook(), "utf8");
    fs.writeFileSync(path.join(src, "sub", "memo.txt"), "The shop opens at nine.", "utf8");
    fs.writeFileSync(path.join(src, ".env"), "TOKEN=never-imported", "utf8");

    const { exitCode, data } = await json("brain", "import", src);
    expect(exitCode).toBe(EXIT.OK);
    expect(data.dryRun).toBe(false);
    const files = data.files as { slug: string; status: string; path: string; chunks: number }[];
    expect(files.map((f) => [f.slug, f.status, f.path])).toEqual([
      ["handbook", "imported", "docs/handbook.md"],
      ["memo", "imported", "docs/memo.md"],
    ]);
    expect(files[0]!.chunks).toBeGreaterThanOrEqual(2);
    expect((data.skipped as { path: string }[]).map((s) => path.basename(s.path))).toEqual([".env"]);
    expect(fs.readFileSync(path.join(profileDir, "brain", "docs", "handbook.md"), "utf8")).toContain("provenance: founder-import");
    expect(JSON.stringify(data)).not.toContain("never-imported");

    const docs = await json("brain", "docs");
    expect(docs.exitCode).toBe(EXIT.OK);
    const listed = docs.data.docs as { slug: string; chunks: number; title: string; format: string }[];
    expect(listed.map((d) => d.slug)).toEqual(["handbook", "memo"]);
    expect(listed[0]).toMatchObject({ title: "Staff handbook", format: "md" });
    expect(listed[0]!.chunks).toBe(files[0]!.chunks);

    const again = await json("brain", "import", path.join(src, "handbook.md"));
    expect((again.data.files as { status: string }[])[0]!.status).toBe("unchanged");
  });

  it("dry-runs an import with a plan and no write, and answers the registry probe with exit 0", async () => {
    seed();
    const file = path.join(home, "plan.md");
    fs.writeFileSync(file, "# Plan\n\nopen a second shop", "utf8");
    const planned = await json("brain", "import", file, "--dry-run");
    expect(planned.exitCode).toBe(EXIT.OK);
    expect(planned.data.dryRun).toBe(true);
    expect((planned.data.files as { status: string; slug: string }[])[0]).toMatchObject({ status: "imported", slug: "plan" });
    expect(fs.existsSync(path.join(profileDir, "brain", "docs"))).toBe(false);

    const probe = await json("brain", "import", "sample", "--dry-run");
    expect(probe.exitCode).toBe(EXIT.OK);
    expect(probe.data).toMatchObject({ dryRun: true, command: "brain import" });
    expect(fs.existsSync(path.join(profileDir, "brain", "docs"))).toBe(false);
  });

  it("refuses a path that does not exist, and writes nothing", async () => {
    seed();
    const result = await runCli(["brain", "import", path.join(home, "nothing-here.md"), "--json"]);
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(`${result.stdout}${result.stderr}`).toContain("nothing-here.md");
    expect(fs.existsSync(path.join(profileDir, "brain", "docs"))).toBe(false);
  });

  it("forgets a document by slug or path, and dry-runs the removal", async () => {
    seed();
    const file = path.join(home, "memo.txt");
    fs.writeFileSync(file, "The shop opens at nine.", "utf8");
    await json("brain", "import", file);
    expect(fs.existsSync(path.join(profileDir, "brain", "docs", "memo.md"))).toBe(true);

    const dry = await json("brain", "forget", "memo", "--dry-run");
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(dry.data).toMatchObject({ dryRun: true, command: "brain forget", path: "docs/memo.md", exists: true });
    expect(fs.existsSync(path.join(profileDir, "brain", "docs", "memo.md"))).toBe(true);

    const gone = await json("brain", "forget", "docs/memo.md");
    expect(gone.exitCode).toBe(EXIT.OK);
    expect(gone.data).toMatchObject({ path: "docs/memo.md", removed: true });
    expect(fs.existsSync(path.join(profileDir, "brain", "docs", "memo.md"))).toBe(false);

    const missing = await runCli(["brain", "forget", "memo", "--json"]);
    expect(missing.exitCode).toBe(EXIT.USAGE);
    const outside = await runCli(["brain", "forget", "../secret.env", "--json"]);
    expect(outside.exitCode).toBe(EXIT.USAGE);
    expect(`${outside.stdout}${outside.stderr}`).not.toContain("never-read-this");
    expect(fs.existsSync(path.join(profileDir, "secret.env"))).toBe(true);
  });

  it("renders import, docs and forget without emoji", async () => {
    seed();
    const file = path.join(home, "memo.txt");
    fs.writeFileSync(file, "The shop opens at nine.", "utf8");
    for (const argv of [["brain", "import", file], ["brain", "docs"], ["brain", "forget", "memo"]]) {
      const result = await runCli(argv);
      expect(result.exitCode, argv.join(" ")).toBe(EXIT.OK);
      expect(/\p{Extended_Pictographic}/u.test(result.stdout)).toBe(false);
    }
  });
});
