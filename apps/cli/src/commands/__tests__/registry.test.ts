/**
 * Task 2.7 — the test that matters most.
 *
 * Commands are enumerated DYNAMICALLY from the Commander instance, walking subcommands
 * recursively. A hard-coded list would let a newly added command forget `--json`; this cannot.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { buildProgram, runCli } from "../index.js";

interface Discovered {
  path: string[];
  cmd: Command;
}

/** Walk the Commander tree. Nothing here knows a single command name. */
function discover(root: Command, prefix: string[] = []): Discovered[] {
  const found: Discovered[] = [];
  for (const cmd of root.commands) {
    if ((cmd as Command & { _hidden?: boolean })._hidden === true) continue;
    const here = [...prefix, cmd.name()];
    found.push({ path: here, cmd });
    found.push(...discover(cmd, here));
  }
  return found;
}

function hasLongOption(cmd: Command, long: string): boolean {
  return cmd.options.some((o) => o.long === long);
}

/** Placeholder values for a command's required arguments, read off Commander itself. */
function sampleArgs(cmd: Command): string[] {
  const declared = (cmd as Command & { registeredArguments?: { required: boolean }[] })
    .registeredArguments;
  if (!declared) return [];
  return declared.filter((a) => a.required).map(() => "sample");
}

let home: string;
const commands = discover(buildProgram());

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-registry-"));
  process.env.TRENT_HOME = home;
});

afterAll(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("command registry (dynamically enumerated)", () => {
  it("discovers the full command surface", () => {
    // eslint-disable-next-line no-console
    console.log(`discovered ${commands.length} commands`);
    expect(commands.length).toBeGreaterThan(25);
  });

  it("covers every command group named in the milestone", () => {
    const names = commands.map((c) => c.path.join(" "));
    for (const required of [
      "doctor",
      "setup",
      "model",
      "fleet list",
      "fleet install",
      "fleet deploy",
      "fleet status",
      "fleet create",
      "skills browse",
      "skills search",
      "skills install",
      "skills remove",
      "skills list",
      "tools",
      "sessions list",
      "sessions resume",
      "sessions prune",
      "config get",
      "config set",
      "config unset",
      "mcp list",
      "mcp add",
      "mcp remove",
      "a2a serve",
      "acp",
      "gateway",
      "egress",
      "update",
      "uninstall",
      "web",
    ]) {
      expect(names, `missing command: ${required}`).toContain(required);
    }
  });

  for (const { path: cmdPath, cmd } of commands) {
    const label = cmdPath.join(" ");

    it(`${label}: declares --json`, () => {
      expect(hasLongOption(cmd, "--json")).toBe(true);
    });

    it(`${label}: has a non-empty description`, () => {
      expect(cmd.description().trim().length).toBeGreaterThan(0);
    });

    it(`${label}: has --help`, () => {
      const helpOption = (cmd as Command & { _helpOption?: { long?: string } })._helpOption;
      expect(helpOption === undefined || helpOption.long === "--help").toBe(true);
      expect(cmd.helpInformation().length).toBeGreaterThan(0);
    });

    it(`${label}: emits parseable JSON`, async () => {
      const result = await runCli([...cmdPath, ...sampleArgs(cmd), "--json", "--dry-run"]);
      expect(result.stdout.trim().length, `no stdout from: ${label}`).toBeGreaterThan(0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toBeTypeOf("object");
      expect(result.exitCode, `${label} exited ${result.exitCode}: ${result.stdout}`).toBe(0);
    });

    it(`${label}: accepts the global flags`, () => {
      for (const flag of ["--profile", "--no-color", "--version", "--dry-run"]) {
        expect(hasLongOption(cmd, flag), `${label} missing ${flag}`).toBe(true);
      }
      expect(cmd.options.some((o) => o.short === "-c")).toBe(true);
    });
  }
});
