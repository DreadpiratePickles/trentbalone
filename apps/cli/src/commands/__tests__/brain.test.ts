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
