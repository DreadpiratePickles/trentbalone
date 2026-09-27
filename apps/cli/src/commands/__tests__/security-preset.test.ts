/**
 * D15 — `trent security preset [paranoid|standard]`.
 *
 * The operator's one-command posture switch. It writes only keys the gate chain already honours,
 * through the ordinary ConfigManager path, prints what changed, and shows the grade before and after.
 * With no argument it shows the active preset and what each preset would change, and writes nothing.
 * It is operator-only: the `lower-trents-own-guardrails` hardline rule refuses it from any tool.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { EXIT } from "@trent/core/errors/index.js";
import { GRADE_ORDER } from "@trent/core/governance/security-grade.js";
import { hardlineBlock } from "@trent/core/governance/hardline.js";
import { runCli } from "../index.js";

let home: string;

const CLEAN_CONFIG = ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", ""].join("\n");
const WEAK_CONFIG = [
  CLEAN_CONFIG,
  "autonomy: never",
  "terminal:",
  "  backend: local",
  "egress:",
  "  enabled: false",
  "disabled_toolsets: [vision]",
  "",
].join("\n");

const configPath = (): string => path.join(home, "config.yaml");
const writeConfig = (body: string): void => fs.writeFileSync(configPath(), body, { mode: 0o600 });
const readConfig = (): Record<string, any> => parseYaml(fs.readFileSync(configPath(), "utf8")) as Record<string, any>;

interface Change {
  key: string;
  from: unknown;
  to: unknown;
}
interface ApplyJson {
  kind: "apply";
  command: string;
  preset: string;
  dryRun: boolean;
  written: boolean;
  activeBefore: string;
  activeAfter: string;
  changes: Change[];
  grade: { before: { grade: string; score: number }; after: { grade: string; score: number } };
  unavailable: Array<{ knob: string; reason: string }>;
}
interface ShowJson {
  kind: "show";
  command: string;
  active: string;
  presets: Array<{ name: string; description: string; changes: Change[] }>;
  unavailable: Array<{ knob: string; reason: string }>;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-secpreset-")));
  process.env.TRENT_HOME = home;
  writeConfig(CLEAN_CONFIG);
  fs.writeFileSync(path.join(home, ".env"), "OPENAI_API_KEY=placeholder\n", { mode: 0o600 });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const preset = async (...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  await runCli(["security", "preset", ...args]);

describe("trent security preset paranoid", () => {
  it("writes exactly the documented keys through the config file", async () => {
    writeConfig(WEAK_CONFIG);
    const result = await preset("paranoid", "--json");

    expect(result.exitCode, result.stderr).toBe(EXIT.OK);
    const cfg = readConfig();
    expect(cfg.terminal.backend).toBe("docker");
    expect(cfg.egress.enabled).toBe(true);
    expect(cfg.autonomy).toBe("ask_always");
    expect(cfg.privacy.redact_prompts).toBe(true);
    expect(cfg.disabled_toolsets).toEqual(["vision", "browser", "social"]);
    // Not an owned key: untouched.
    expect(cfg.model).toBe("gpt-5.6-terra");
  });

  it("has a stable --json shape: the diff, the preset before and after, the grade before and after", async () => {
    writeConfig(WEAK_CONFIG);
    const data = JSON.parse((await preset("paranoid", "--json")).stdout) as ApplyJson;

    expect(Object.keys(data).sort()).toEqual(
      ["kind", "command", "preset", "dryRun", "written", "activeBefore", "activeAfter", "changes", "grade", "unavailable"].sort(),
    );
    expect(data.kind).toBe("apply");
    expect(data.command).toBe("security preset");
    expect(data.preset).toBe("paranoid");
    expect(data.dryRun).toBe(false);
    expect(data.written).toBe(true);
    expect(data.activeBefore).toBe("custom");
    expect(data.activeAfter).toBe("paranoid");
    expect(data.changes.map((c) => c.key)).toEqual([
      "terminal.backend",
      "egress.enabled",
      "autonomy",
      "privacy.redact_prompts",
      "disabled_toolsets",
    ]);
    expect(data.changes[2]).toEqual({ key: "autonomy", from: "never", to: "ask_always" });
    expect(GRADE_ORDER).toContain(data.grade.before.grade);
    expect(GRADE_ORDER).toContain(data.grade.after.grade);
    expect(data.unavailable.map((u) => u.knob)).toContain("offline");
  });

  it("raises the grade on a weakened profile", async () => {
    writeConfig(WEAK_CONFIG);
    const data = JSON.parse((await preset("paranoid", "--json")).stdout) as ApplyJson;
    const rank = (g: string): number => GRADE_ORDER.indexOf(g as (typeof GRADE_ORDER)[number]);

    expect(rank(data.grade.after.grade)).toBeLessThan(rank(data.grade.before.grade));
    expect(data.grade.after.score).toBeLessThan(data.grade.before.score);
  });

  it("never lowers the grade on a clean profile", async () => {
    const data = JSON.parse((await preset("paranoid", "--json")).stdout) as ApplyJson;
    const rank = (g: string): number => GRADE_ORDER.indexOf(g as (typeof GRADE_ORDER)[number]);

    expect(rank(data.grade.after.grade)).toBeLessThanOrEqual(rank(data.grade.before.grade));
    expect(data.grade.after.score).toBeLessThanOrEqual(data.grade.before.score);
  });

  it("is idempotent: the second run changes nothing and leaves the file byte-identical", async () => {
    writeConfig(WEAK_CONFIG);
    await preset("paranoid", "--json");
    const first = fs.readFileSync(configPath(), "utf8");
    const again = JSON.parse((await preset("paranoid", "--json")).stdout) as ApplyJson;

    expect(again.changes).toEqual([]);
    expect(again.written).toBe(false);
    expect(again.activeBefore).toBe("paranoid");
    expect(fs.readFileSync(configPath(), "utf8")).toBe(first);
  });

  it("writes nothing under --dry-run, and still reports the diff and the grade it would produce", async () => {
    writeConfig(WEAK_CONFIG);
    const before = fs.readFileSync(configPath(), "utf8");
    const result = await preset("paranoid", "--json", "--dry-run");

    expect(result.exitCode).toBe(EXIT.OK);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    const data = JSON.parse(result.stdout) as ApplyJson;
    expect(data.dryRun).toBe(true);
    expect(data.written).toBe(false);
    expect(data.changes.length).toBe(5);
    expect(data.activeAfter).toBe("paranoid");
  });

  it("renders the diff and the grade transition for a human", async () => {
    writeConfig(WEAK_CONFIG);
    const result = await preset("paranoid");

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("SECURITY PRESET");
    expect(result.stdout).toContain("autonomy");
    expect(result.stdout).toContain("ask_always");
    // eslint-disable-next-line no-control-regex
    expect(result.stdout.replace(/\u001b\[[0-9;]*m/g, "")).toMatch(/grade\s+[A-F]\s+→\s+[A-F]/);
  });
});

describe("trent security preset standard", () => {
  it("restores the documented defaults of every owned key after paranoid", async () => {
    await preset("paranoid", "--json");
    const data = JSON.parse((await preset("standard", "--json")).stdout) as ApplyJson;

    expect(data.activeAfter).toBe("standard");
    const cfg = readConfig();
    expect(cfg.autonomy).toBe("ask_dangerous");
    expect(cfg.privacy.redact_prompts).toBe(false);
    expect(cfg.terminal.backend).toBe("docker");
    expect(cfg.egress.enabled).toBe(true);
    expect(cfg.disabled_toolsets).toEqual([]);
  });

  it("changes nothing on a default profile", async () => {
    const data = JSON.parse((await preset("standard", "--json")).stdout) as ApplyJson;
    expect(data.changes).toEqual([]);
    expect(data.written).toBe(false);
  });
});

describe("trent security preset (no argument)", () => {
  it("shows the active preset and what each would change, and writes nothing", async () => {
    writeConfig(WEAK_CONFIG);
    const before = fs.readFileSync(configPath(), "utf8");
    const result = await preset("--json");

    expect(result.exitCode).toBe(EXIT.OK);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    const data = JSON.parse(result.stdout) as ShowJson;
    expect(Object.keys(data).sort()).toEqual(["kind", "command", "active", "presets", "unavailable"].sort());
    expect(data.kind).toBe("show");
    expect(data.active).toBe("custom");
    expect(data.presets.map((p) => p.name)).toEqual(["paranoid", "standard"]);
    const paranoid = data.presets.find((p) => p.name === "paranoid")!;
    expect(paranoid.changes.find((c) => c.key === "autonomy")).toEqual({ key: "autonomy", from: "never", to: "ask_always" });
  });

  it("renders the active preset for a human", async () => {
    const result = await preset();
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("active");
    expect(result.stdout).toContain("standard");
    expect(result.stdout).toContain("paranoid");
  });
});

describe("an unknown preset", () => {
  it("is a usage error and writes nothing", async () => {
    const before = fs.readFileSync(configPath(), "utf8");
    const result = await preset("open", "--json");

    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("operator-only", () => {
  // The rule itself is pinned in packages/trent-core/src/governance/hardline.test.ts
  // ("trent security preset open"); this asserts each form THIS command takes is refused from a tool.
  it("every form of the command is refused by the lower-trents-own-guardrails hardline rule", () => {
    const ctx = { home: "/home/founder", profileDir: "/home/founder/.trent/default" };
    for (const command of [
      "trent security preset",
      "trent security preset paranoid",
      "trent security preset standard",
      "trent security preset standard --dry-run --json",
    ]) {
      expect(hardlineBlock([{ kind: "command", value: command }], ctx)?.id, command).toBe("lower-trents-own-guardrails");
    }
  });
});
