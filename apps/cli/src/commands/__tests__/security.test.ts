/**
 * `trent security audit [workspace]`: the read-only report a user runs before trusting a profile.
 *
 * The contract a script depends on is the exit code — 0 when the profile is clean, 1 when the
 * report has findings — and `--json` being parseable in both cases. Nothing here writes to the
 * profile, so the same command can be run in CI on a machine nobody is sitting at.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;
let workspace: string;

const CLEAN_CONFIG = ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", ""].join("\n");

interface AuditJson {
  profile: string;
  profileDir: string;
  ok: boolean;
  sections: Array<{ id: string; title: string; details: Record<string, unknown> }>;
  findings: Array<{ id: string; section: string; severity: string; message: string; fix: string }>;
}

const writeConfig = (body: string): void => {
  fs.writeFileSync(path.join(home, "config.yaml"), body, { mode: 0o644 });
};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-secaudit-")));
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-secaudit-ws-")));
  process.env.TRENT_HOME = home;
  writeConfig(CLEAN_CONFIG);
  fs.writeFileSync(path.join(home, ".env"), "OPENAI_API_KEY=placeholder\n", { mode: 0o600 });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const run = async (...extra: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  await runCli(["security", "audit", workspace, ...extra]);

describe("a clean profile", () => {
  it("exits 0 and says it found nothing", async () => {
    const result = await run("--json");

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as AuditJson;
    expect(data.ok).toBe(true);
    expect(data.findings).toEqual([]);
    expect(data.profileDir).toBe(home);
    expect(data.sections.length).toBeGreaterThan(8);
  });

  it("renders a human report that names every section", async () => {
    const result = await run();

    expect(result.exitCode).toBe(EXIT.OK);
    for (const title of ["autonomy", "hooks", "egress", "plugins"]) {
      expect(result.stdout.toLowerCase()).toContain(title);
    }
  });
});

describe("a profile that has been weakened", () => {
  beforeEach(() => {
    writeConfig(
      [
        CLEAN_CONFIG,
        "autonomy: never",
        "hooks:",
        "  pre_tool_call:",
        "    - command: [/bin/echo, gate]",
        "openai_api_key: sk-notarealkeyjustashapethatmatches",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(home, ".env"), 0o644);
  });

  it("exits 1 and names the unconsented hook, the readable .env, the autonomy level and the secret", async () => {
    const result = await run("--json");

    expect(result.exitCode).toBe(EXIT.RUN_FAILED);
    const data = JSON.parse(result.stdout) as AuditJson;
    expect(data.ok).toBe(false);
    expect(data.findings.map((f) => f.id).sort()).toEqual([
      "autonomy-never",
      "hook-not-consented",
      "profile-file-too-permissive",
      "secret-in-config-yaml",
    ]);
  });

  it("never prints the secret it found, in either output mode", async () => {
    const json = await run("--json");
    const human = await run();

    expect(json.stdout).not.toContain("sk-notarealkeyjustashapethatmatches");
    expect(human.stdout).not.toContain("sk-notarealkeyjustashapethatmatches");
    expect(human.exitCode).toBe(EXIT.RUN_FAILED);
  });

  it("prints a fix line for every finding in the human report", async () => {
    const json = JSON.parse((await run("--json")).stdout) as AuditJson;
    const human = await run();

    for (const finding of json.findings) {
      expect(human.stdout, `no fix line for ${finding.id}`).toContain(finding.fix);
    }
  });
});

describe("the flags every command carries", () => {
  it("reports what it would read under --dry-run and exits 0", async () => {
    fs.chmodSync(path.join(home, ".env"), 0o644);
    const result = await run("--json", "--dry-run");

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { dryRun: boolean; command: string; sections: string[] };
    expect(data.dryRun).toBe(true);
    expect(data.command).toBe("security audit");
    expect(data.sections.length).toBeGreaterThan(8);
  });
});
